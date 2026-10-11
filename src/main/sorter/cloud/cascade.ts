/**
 * The sorter cascade's bookkeeping, pure: which step made the call for a screenshot, and how a cloud
 * model's answer (Luna's or Haiku's) joins a doubtful proposal under the same keep-bias as the local
 * steps.
 *
 *   decidedByLocal(): 'rules' when the rule alone would have reached the same confident proposal,
 *     else 'your history' (the classifier trained on his choices, with the look-alike signal); null
 *     for doubtful (no step made a call).
 *   applyCloud(): only a doubtful proposal changes. keep → keep; throwaway → throwaway only when
 *     the model's confidence reaches the same throwaway threshold the local sorter uses (never below
 *     the floor); unsure, or a less confident throwaway → stays doubtful for the review screen. The
 *     row records who answered: decidedBy names the provider's model ('luna' = OpenAI's Luna,
 *     'haiku' = Anthropic's Haiku) and decidedModel the exact model id.
 *   applyLuna(): applyCloud for Luna.
 */
import { checkThresholds, decide, DEFAULT_THRESHOLDS, type Proposal, type Thresholds, type Verdict } from '../decide'
import type { RuleVerdict } from '../rules'
import { LUNA, type LunaAnswer } from './luna'

/** Stored codes; the words shown are DECIDED_BY_WORDS. */
export type DecidedBy = 'rules' | 'history' | 'luna' | 'haiku'
export const DECIDED_BY_WORDS: Record<DecidedBy, string> = { rules: 'rules', history: 'your history', luna: 'asked Luna', haiku: 'asked Haiku' }

/** The cloud model an answer came from (a CloudProvider, provider.ts, is one). */
export type CloudVoice = { decidedBy: 'luna' | 'haiku'; name: string; model: string }

export function decidedByLocal(verdict: Pick<Verdict, 'proposal'>, rule: RuleVerdict | null, thresholds: Thresholds = DEFAULT_THRESHOLDS): DecidedBy | null {
  if (verdict.proposal === 'doubtful') return null
  if (rule && decide(rule, null, thresholds).proposal === verdict.proposal) return 'rules'
  return 'history'
}

export type CascadeRow = { proposal: Proposal; confidence: number; pKeep: number; reason: string; decidedBy: DecidedBy | null; /** The model id when a cloud model made the call. */ decidedModel?: string | null }

const pct = (x: number): string => `${Math.round(x * 100)}%`
const lower = (s: string): string => (s ? s[0].toLowerCase() + s.slice(1) : s)
const stop = (s: string): string => s.replace(/[.\s]+$/, '')

/** The proposal after a cloud model's answer. A proposal that is not doubtful is returned unchanged. */
export function applyCloud(local: CascadeRow, answer: LunaAnswer, who: CloudVoice, thresholds: Thresholds = DEFAULT_THRESHOLDS): CascadeRow {
  if (local.proposal !== 'doubtful') return local
  const t = checkThresholds(thresholds)
  const said = stop(answer.reason) || 'no reason given'
  const by = { decidedBy: who.decidedBy, decidedModel: who.model }
  if (answer.verdict === 'keep') {
    return { proposal: 'keep', confidence: answer.confidence, pKeep: answer.confidence, reason: said, ...by }
  }
  if (answer.verdict === 'throwaway' && answer.confidence >= t.throwaway) {
    return { proposal: 'throwaway', confidence: answer.confidence, pKeep: 1 - answer.confidence, reason: said, ...by }
  }
  const reason =
    answer.verdict === 'throwaway'
      ? `Not sure: ${who.name} leans throwaway (${pct(answer.confidence)}), not sure enough to throw away: ${lower(said)}`
      : `Not sure, and ${who.name} was not sure either: ${lower(said)}`
  return { ...local, reason, ...by }
}

const LUNA_VOICE: CloudVoice = { decidedBy: 'luna', name: 'Luna', model: LUNA.model }

/** The proposal after Luna's answer. */
export function applyLuna(local: CascadeRow, answer: LunaAnswer, thresholds: Thresholds = DEFAULT_THRESHOLDS): CascadeRow {
  return applyCloud(local, answer, LUNA_VOICE, thresholds)
}
