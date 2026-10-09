/**
 * The sorter's verdict for one screenshot: keep / throwaway / doubtful, a confidence, and a reason in
 * plain words. Combines the rule lean (rules.ts) and the classifier's p(keep) (classifier.ts) in
 * log-odds, then applies the **keep-bias** thresholds: throwaway only when p(throwaway) reaches the
 * throwaway threshold (never below THROWAWAY_FLOOR); keep when p(keep) reaches the keep threshold;
 * everything between is doubtful and goes to the review queue. Pure.
 */
import type { RuleVerdict } from './rules'
import type { Tier } from '../look-alike/groups'

/**
 * Stored with every model, report and proposal; bump when rules, combination, classifier, calibration
 * or the evaluation procedure change. Sorting uses only a model trained under the current version.
 * 2: calibrated, near-duplicates grouped, evidence gate.
 * 3: a copy of a kept screenshot leans throwaway (look-alike signal).
 */
export const SORTER_VERSION = 'sorter-local-3'

export type Proposal = 'keep' | 'throwaway' | 'doubtful'

export type Thresholds = {
  /** p(throwaway) at or above this → throwaway. */
  throwaway: number
  /** p(keep) at or above this → keep. */
  keep: number
}

/**
 * The look-alike signal: the best tier between this screenshot and any screenshot he already kept
 * (look-alike/groups.ts), or null. It only adds log-odds toward throwaway; it never decides alone:
 * the throwaway threshold still applies, so no signal can make anything throwaway below it.
 * PROVISIONAL sizes, to be set from his verdict on the pair sheet.
 */
export type KeptCopy = Tier | null
export const KEPT_COPY_NUDGE: Record<Tier, number> = { 'same-picture': 1.2, 'same-thing': 0.6 }

/** No configuration may let the sorter call something throwaway below this. */
export const THROWAWAY_FLOOR = 0.85
export const DEFAULT_THRESHOLDS: Thresholds = { throwaway: 0.9, keep: 0.7 }

export type Verdict = {
  proposal: Proposal
  /** Probability of the proposed label; for doubtful, the larger of the two. */
  confidence: number
  /** p(keep) after combining rule and classifier. */
  pKeep: number
  reason: string
}

/** Thresholds must keep the bias: throwaway ≥ floor, keep in (0.5, 1]. Throws otherwise. */
export function checkThresholds(t: Thresholds): Thresholds {
  if (!(t.throwaway >= THROWAWAY_FLOOR && t.throwaway < 1)) throw new Error(`throwaway threshold ${t.throwaway} must be at least ${THROWAWAY_FLOOR} and below 1`)
  if (!(t.keep > 0.5 && t.keep <= 1)) throw new Error(`keep threshold ${t.keep} must be above 0.5`)
  return t
}

const clamp = (p: number): number => Math.min(1 - 1e-6, Math.max(1e-6, p))
const logit = (p: number): number => Math.log(clamp(p) / (1 - clamp(p)))
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z))

/** Strip the trailing "— usually …" from a rule reason, for use inside a longer sentence. */
const bare = (reason: string): string =>
  reason.replace(/\s+—\s+usually (kept|throwaway)$/, '').replace(/^(Looks|Mentions|Slides)\b/, (w) => w.toLowerCase())

function reasonFor(proposal: Proposal, rule: RuleVerdict | null, pKeepModel: number | null, copy: KeptCopy = null): string {
  const base = reasonBase(proposal, rule, pKeepModel)
  if (!copy || proposal === 'keep') return base
  return `${base}; ${copy === 'same-picture' ? 'looks the same as' : 'looks like an edited version of'} one you already kept`
}

function reasonBase(proposal: Proposal, rule: RuleVerdict | null, pKeepModel: number | null): string {
  const model = pKeepModel === null ? null : pKeepModel >= 0.5 ? 'keep' : 'throwaway'
  const modelWords = model === 'keep' ? 'looks like screenshots you kept before' : 'looks like screenshots you binned before'
  const cap = (s: string): string => s[0].toUpperCase() + s.slice(1)
  if (proposal === 'throwaway') {
    if (rule?.lean === 'throwaway') return model === 'throwaway' ? `${rule.reason}; ${modelWords}` : rule.reason
    return cap(modelWords)
  }
  if (proposal === 'keep') {
    if (rule?.lean === 'keep') return model === 'keep' ? `${rule.reason}; ${modelWords}` : rule.reason
    return cap(modelWords)
  }
  // doubtful
  if (rule && model && rule.lean !== model) return `Not sure: ${bare(rule.reason)}, but it ${modelWords}`
  if (rule) return `Not sure: ${bare(rule.reason)}, but not sure enough to ${rule.lean === 'keep' ? 'keep without a look' : 'throw away'}`
  if (model === 'throwaway') return 'Not sure: it looks like screenshots you binned before, but not sure enough to throw away'
  if (model === 'keep') return 'Not sure: it looks a bit like screenshots you kept, but not clearly'
  return 'Not sure: no rule fits and there is nothing learnt to compare it with'
}

/**
 * One verdict. `pKeepModel` is null when there is no trained classifier or no embedding for this
 * picture; then the rule alone decides, and only when its own confidence clears the thresholds.
 */
export function decide(rule: RuleVerdict | null, pKeepModel: number | null, thresholds: Thresholds = DEFAULT_THRESHOLDS, keptCopy: KeptCopy = null): Verdict {
  const t = checkThresholds(thresholds)
  const ruleLogit = rule ? (rule.lean === 'throwaway' ? 1 : -1) * logit(rule.confidence) : 0
  const modelLogit = pKeepModel === null ? 0 : logit(1 - pKeepModel)
  // rule alone: its own confidence, exactly (no log-odds round trip)
  const nudge = keptCopy ? KEPT_COPY_NUDGE[keptCopy] : 0
  const pThrow =
    pKeepModel !== null || nudge > 0
      ? sigmoid(modelLogit + ruleLogit + nudge)
      : rule
        ? rule.lean === 'throwaway' ? rule.confidence : 1 - rule.confidence
        : 0.5
  const pKeep = 1 - pThrow
  let proposal: Proposal
  let confidence: number
  if (pThrow >= t.throwaway) {
    proposal = 'throwaway'
    confidence = pThrow
  } else if (pKeep >= t.keep) {
    proposal = 'keep'
    confidence = pKeep
  } else {
    proposal = 'doubtful'
    confidence = Math.max(pKeep, pThrow)
  }
  return { proposal, confidence, pKeep, reason: reasonFor(proposal, rule, pKeepModel, keptCopy) }
}
