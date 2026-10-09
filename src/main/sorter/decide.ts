/**
 * The sorter's verdict for one screenshot: keep / throwaway / doubtful, a confidence, and a reason in
 * plain words. Combines the rule lean (rules.ts) and the classifier's p(keep) (classifier.ts) in
 * log-odds, then applies the **keep-bias** thresholds: throwaway only when p(throwaway) reaches the
 * throwaway threshold (never below THROWAWAY_FLOOR); keep when p(keep) reaches the keep threshold;
 * everything between is doubtful and goes to the review queue. Pure.
 */
import type { RuleVerdict } from './rules'

/**
 * Stored with every model, report and proposal; bump when rules, combination, classifier, calibration
 * or the evaluation procedure change. Sorting uses only a model trained under the current version.
 * 2: calibrated, near-duplicates grouped, evidence gate.
 */
export const SORTER_VERSION = 'sorter-local-2'

export type Proposal = 'keep' | 'throwaway' | 'doubtful'

export type Thresholds = {
  /** p(throwaway) at or above this → throwaway. */
  throwaway: number
  /** p(keep) at or above this → keep. */
  keep: number
}

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

function reasonFor(proposal: Proposal, rule: RuleVerdict | null, pKeepModel: number | null): string {
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
export function decide(rule: RuleVerdict | null, pKeepModel: number | null, thresholds: Thresholds = DEFAULT_THRESHOLDS): Verdict {
  const t = checkThresholds(thresholds)
  const ruleLogit = rule ? (rule.lean === 'throwaway' ? 1 : -1) * logit(rule.confidence) : 0
  const modelLogit = pKeepModel === null ? 0 : logit(1 - pKeepModel)
  // rule alone: its own confidence, exactly (no log-odds round trip)
  const pThrow = pKeepModel !== null ? sigmoid(modelLogit + ruleLogit) : rule ? (rule.lean === 'throwaway' ? rule.confidence : 1 - rule.confidence) : 0.5
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
  return { proposal, confidence, pKeep, reason: reasonFor(proposal, rule, pKeepModel) }
}
