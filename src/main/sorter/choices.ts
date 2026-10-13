/**
 * Counting his choices for teaching the sorter (ticket 22). Pure.
 *
 * A "choice" is a screenshot he kept or threw away whose picture can be read on this Mac: the ones
 * training can learn from (service.ts count(), store.ts loadLabelled). An answer in a teaching round
 * or in Review is the same keep / throw-away decision Triage writes, so it shows up here as one more
 * choice; there is no separate record of answers.
 *
 *   answersSince(): choices now minus the choices the model in use was trained with.
 *   moreChoicesNeeded(): how many more choices before a training can be measured at all: the
 *     held-back fifth must reach MIN_HELD_BACK (accuracy.ts), in all and of each kind.
 */
import type { SorterTeachStatus } from '../../preload'
import { HOLD_OUT_FRACTION, MIN_HELD_BACK } from './accuracy'

/** The sorter retrains by itself after this many answers. Fixed: only on/off and on-battery are settings. */
export const RETRAIN_EVERY = 10

/** His choices that can be learnt from (the field names are SorterStatus.learnable's). */
export type Choices = { kept: number; binned: number }

/** How many of `n` screenshots of one kind the split holds back at most (accuracy.ts holdOutSplit's target). */
function heldBackOf(n: number): number {
  return n >= 2 ? Math.max(1, Math.ceil(n * HOLD_OUT_FRACTION)) : 0
}

/**
 * The fewest further choices after which the held-back sample can reach the minimum: first enough of
 * each kind, then enough in all (added to whichever kind he has fewer of). 0 = enough already.
 * Related screenshots are held back together (groups.ts), so a history full of near-copies can still
 * come out short after this says 0; the training's own report is the final word.
 */
export function moreChoicesNeeded(c: Choices | null | undefined): number {
  let kept = Math.max(0, Math.floor(c?.kept ?? 0))
  let thrown = Math.max(0, Math.floor(c?.binned ?? 0))
  let more = 0
  while (heldBackOf(kept) < MIN_HELD_BACK.perLabel) {
    kept++
    more++
  }
  while (heldBackOf(thrown) < MIN_HELD_BACK.perLabel) {
    thrown++
    more++
  }
  while (heldBackOf(kept) + heldBackOf(thrown) < MIN_HELD_BACK.total) {
    if (kept <= thrown) kept++
    else thrown++
    more++
  }
  return more
}

/**
 * Answers since the last training: his choices now minus those the model in use was trained with.
 * 0 when either is unknown (nothing counted yet, or no current model) and never below 0 (an undone
 * decision takes a choice away again).
 */
export function answersSince(now: Choices | null | undefined, trainedWith: number | null | undefined): number {
  if (!now || typeof trainedWith !== 'number' || !Number.isFinite(trainedWith)) return 0
  return Math.max(0, now.kept + now.binned - trainedWith)
}

/**
 * The choices a report's model was trained with. Reports from before this was recorded carry only
 * the screenshots that were embedded (`usable`), which is the same number unless a picture could not
 * be read.
 */
export function choicesAtTraining(report: { choicesAtTraining?: unknown; usable?: { keep?: unknown; throwaway?: unknown } } | null | undefined): number | null {
  if (!report) return null
  if (typeof report.choicesAtTraining === 'number' && Number.isFinite(report.choicesAtTraining)) return report.choicesAtTraining
  const k = report.usable?.keep
  const t = report.usable?.throwaway
  return typeof k === 'number' && typeof t === 'number' ? k + t : null
}

/** The fewest choices with which the held-back sample can be big enough: 92 (46 of each kind), "about 100" on the chart. */
export const MIN_CHOICES = moreChoicesNeeded({ kept: 0, binned: 0 })

/** The teaching part of the sorter status when nothing supplies it (service.ts SorterDeps.teach absent): no retrain by itself is wired, and none has run. */
export function teachDefaults(c: { learnable: Choices | null }): SorterTeachStatus {
  return { answersSinceTraining: 0, retrainEvery: RETRAIN_EVERY, autoRetrain: false, autoRetrainOnBattery: false, retraining: null, waitingForPower: null, choicesNeeded: moreChoicesNeeded(c.learnable), lastRetrain: null }
}
