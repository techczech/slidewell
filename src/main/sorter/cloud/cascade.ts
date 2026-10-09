/**
 * The sorter cascade's bookkeeping, pure: which step made the call for a screenshot, and how Luna's
 * answer joins a doubtful proposal under the same keep-bias as the local steps.
 *
 *   decidedByLocal(): 'rules' when the rule alone would have reached the same confident proposal,
 *     else 'your history' (the classifier trained on his choices, with the look-alike signal); null
 *     for doubtful (no step made a call).
 *   applyLuna(): only a doubtful proposal changes. keep → keep; throwaway → throwaway only when
 *     Luna's confidence reaches the same throwaway threshold the local sorter uses (never below the
 *     floor); unsure, or a less confident throwaway → stays doubtful for the review screen.
 */
import { checkThresholds, decide, DEFAULT_THRESHOLDS, type Proposal, type Thresholds, type Verdict } from '../decide'
import type { RuleVerdict } from '../rules'
import type { LunaAnswer } from './luna'

/** Stored codes; the words shown are DECIDED_BY_WORDS. */
export type DecidedBy = 'rules' | 'history' | 'luna'
export const DECIDED_BY_WORDS: Record<DecidedBy, string> = { rules: 'rules', history: 'your history', luna: 'asked Luna' }

export function decidedByLocal(verdict: Pick<Verdict, 'proposal'>, rule: RuleVerdict | null, thresholds: Thresholds = DEFAULT_THRESHOLDS): DecidedBy | null {
  if (verdict.proposal === 'doubtful') return null
  if (rule && decide(rule, null, thresholds).proposal === verdict.proposal) return 'rules'
  return 'history'
}

export type CascadeRow = { proposal: Proposal; confidence: number; pKeep: number; reason: string; decidedBy: DecidedBy | null }

const pct = (x: number): string => `${Math.round(x * 100)}%`
const lower = (s: string): string => (s ? s[0].toLowerCase() + s.slice(1) : s)
const stop = (s: string): string => s.replace(/[.\s]+$/, '')

/** The proposal after Luna's answer. A proposal that is not doubtful is returned unchanged. */
export function applyLuna(local: CascadeRow, answer: LunaAnswer, thresholds: Thresholds = DEFAULT_THRESHOLDS): CascadeRow {
  if (local.proposal !== 'doubtful') return local
  const t = checkThresholds(thresholds)
  const said = stop(answer.reason) || 'no reason given'
  if (answer.verdict === 'keep') {
    return { proposal: 'keep', confidence: answer.confidence, pKeep: answer.confidence, reason: said, decidedBy: 'luna' }
  }
  if (answer.verdict === 'throwaway' && answer.confidence >= t.throwaway) {
    return { proposal: 'throwaway', confidence: answer.confidence, pKeep: 1 - answer.confidence, reason: said, decidedBy: 'luna' }
  }
  const reason =
    answer.verdict === 'throwaway'
      ? `Not sure: Luna leans throwaway (${pct(answer.confidence)}), not sure enough to throw away: ${lower(said)}`
      : `Not sure, and Luna was not sure either: ${lower(said)}`
  return { ...local, reason, decidedBy: 'luna' }
}
