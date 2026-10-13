/**
 * One screenshot's proposal from everything the local sorter has: the rule that fires on it, the
 * classifier's p(keep) for its picture, the look-alike signal, and an answer a cloud model already
 * gave. Used by a sort (service.ts sortUndecided) and by the re-score after a retrain (rescore.ts),
 * so both make the same call for the same screenshot. Pure: nothing is read or written here, and no
 * cloud model is asked; a stored answer is only applied again.
 */
import { applyRules, type AppRuleLookup } from './rules'
import { predictKeep, type Classifier } from './classifier'
import { decide, type KeptCopy, type Thresholds } from './decide'
import { applyCloud, decidedByLocal, settledAnswer } from './cloud/cascade'
import { voiceOfAnswer } from './cloud/provider'
import type { ProposalRow, Shot, StoredCloudAnswer } from './store'

export type ScoreContext = {
  model: Classifier
  thresholds: Thresholds
  /** His per-app rules (app-rules.ts appRuleLookup). */
  rules: AppRuleLookup
  /** Stored cloud answers that count now, by hash (store.ts cloudAnswersIn). */
  asked: ReadonlyMap<string, StoredCloudAnswer[]>
}

/**
 * The proposal row for one screenshot. `vector` is its picture's embedding (absent: the rule alone
 * decides); `keptCopy` its best look-alike tier against what he kept.
 */
export function scoreShot(shot: Pick<Shot, 'facts'> & { hash: string }, vector: Float32Array | undefined, keptCopy: KeptCopy, c: ScoreContext): ProposalRow {
  const rule = applyRules(shot.facts, c.rules)
  const verdict = decide(rule, vector ? predictKeep(c.model, vector) : null, c.thresholds, vector ? keptCopy : null)
  const local = { proposal: verdict.proposal, confidence: verdict.confidence, pKeep: verdict.pKeep, reason: verdict.reason, decidedBy: decidedByLocal(verdict, rule, c.thresholds) }
  // more than one provider may have answered it: the answer that is a decision stands, else the one asked last
  const answer = verdict.proposal === 'doubtful' ? settledAnswer(c.asked.get(shot.hash) ?? [], c.thresholds) : null
  const who = answer ? voiceOfAnswer(answer.model, answer.promptVersion) : null
  const row = answer && who ? applyCloud(local, answer, who, c.thresholds) : local
  return { hash: shot.hash, ...row, rule: rule?.rule ?? null }
}
