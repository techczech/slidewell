/**
 * "How much is enough" (ticket 22): the sorter trained on growing parts of his choices, each tested
 * on the same held-back sample, and a verdict on whether more answers are still helping.
 *
 * The held-back sample is the one a training holds back (same grouping, same split: accuracy.ts
 * holdOutSplit), so it never overlaps any part trained on. The rest is put in a fixed order that
 * keeps his mix of kept and thrown away in every leading part (nestedOrder), and the sorter is
 * trained on the first part, the first two parts, and so on up to all of it: at most MAX_STEPS
 * trainings, each exactly as a real training would be at that size (its own cross-validated
 * regularisation and calibration), then rules + model on the held-back sample as the accuracy report
 * measures them. A size that cannot be trained (too few of one kind to calibrate) gives a point with
 * no numbers.
 *
 * Cost: the trainings together are about three and a half full trainings. They run as jobs in the
 * training worker (jobs.ts), never in the main process, and only when the reading is asked for. The
 * reading is kept per training (in memory and in config), so it is computed once after each training
 * and answered from the stored one until the next. Embeddings are read through the picture engine,
 * which has them stored for anything a training or sort already looked at.
 *
 * Nothing is written to triage.db and nothing here sorts or decides.
 */
import type { IndexItem } from '../picture-search/vector-store'
import type { SorterLearning, SorterLearningPoint } from '../../preload'
import { accuracyReport, holdOutSplit, HOLD_OUT_FRACTION, type LabelledPrediction } from './accuracy'
import { appRuleLookup, storedAppRules } from './app-rules'
import { MIN_CHOICES, moreChoicesNeeded, storedTime } from './choices'
import { predictKeep, type Example } from './classifier'
import { decide, DEFAULT_THRESHOLDS, type Thresholds } from './decide'
import { runJob, type Job, type JobResult } from './jobs'
import { applyRules } from './rules'
import { loadLabelled, type Shot } from './store'

/** At most this many points on the curve. */
export const MAX_STEPS = 6
/** A step is not smaller than this many choices: below it the numbers are mostly chance. */
export const MIN_STEP = 50

/**
 * "Still helping" needs, over the last two steps of the curve, one of:
 *   - throwaway right rising by at least 1 point per 100 further choices. The held-back sample is a
 *     fifth of his choices (some 20 to 150 screenshots), so one screenshot is worth half a point to
 *     five points; a rise smaller than a point per hundred answers cannot be told from that noise.
 *   - the share needing a look falling by at least 2 points per 100 further choices. Below that, a
 *     hundred answers take fewer than two screenshots in a hundred out of the queue: answering them
 *     costs him more looks than it saves.
 * Otherwise the curve is levelling off.
 */
export const HELPING = { throwawayRightPer100: 0.01, needALookPer100: 0.02 }

/** The total choices at each point: at most MAX_STEPS, evenly spaced, the last = all of them. */
export function curveSteps(choices: number): number[] {
  const n = Math.max(0, Math.floor(choices))
  if (n === 0) return []
  const k = Math.min(MAX_STEPS, Math.max(1, Math.floor(n / MIN_STEP)))
  return Array.from({ length: k }, (_, i) => Math.round((n * (i + 1)) / k))
}

/** FNV-1a 32-bit: an order that depends only on the key. */
function fnv(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/**
 * A fixed order in which every leading part has his kept and thrown-away choices in about the
 * proportion of the whole: each kind in the order of its keys' hashes, then merged by each item's
 * place within its kind. The same choices always give the same order, and adding a choice moves the
 * others only slightly.
 */
export function nestedOrder<T>(items: T[], keyOf: (t: T) => string, keepOf: (t: T) => boolean): T[] {
  const placed: Array<{ t: T; at: number; key: string }> = []
  for (const kind of [true, false]) {
    const group = items.filter((t) => keepOf(t) === kind).sort((a, b) => fnv(keyOf(a)) - fnv(keyOf(b)) || (keyOf(a) < keyOf(b) ? -1 : 1))
    group.forEach((t, i) => placed.push({ t, at: (i + 0.5) / group.length, key: keyOf(t) }))
  }
  return placed.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((p) => p.t)
}

/**
 * The verdict from the curve. `more` > 0 (too few choices to measure a training): not-enough.
 * Otherwise the slope over the last two steps (three points; fewer when there are fewer) against
 * HELPING. With fewer than two measured points there is no slope, and the answer is still-helping:
 * nothing shows that more would not help.
 */
export function learningVerdict(points: readonly SorterLearningPoint[], more: number): SorterLearning['verdict'] {
  if (more > 0) return 'not-enough'
  const measured = points.filter((p) => p.needALook !== null)
  if (measured.length < 2) return 'still-helping'
  const b = measured[measured.length - 1]
  const a = measured[Math.max(0, measured.length - 3)]
  const hundreds = (b.choices - a.choices) / 100
  if (!(hundreds > 0)) return 'still-helping'
  const lessLooking = (a.needALook! - b.needALook!) / hundreds
  const moreRight = a.throwawayRight !== null && b.throwawayRight !== null ? (b.throwawayRight - a.throwawayRight) / hundreds : 0
  return lessLooking >= HELPING.needALookPer100 || moreRight >= HELPING.throwawayRightPer100 ? 'still-helping' : 'levelling-off'
}

export type LearningDeps = {
  wellRoot: () => string
  pictures: {
    modelReady: () => boolean
    ensureVectors: (items: IndexItem[], opts: { signal?: AbortSignal }) => Promise<Map<string, Float32Array>>
  }
  /** The training worker (the same one SorterService uses). Absent: in-process (unit tests). */
  runJob?: <J extends Job>(job: J, signal: AbortSignal) => Promise<JobResult<J>>
  /** His per-app rules as stored in config. */
  appRules?: () => unknown
  thresholds?: Thresholds
  /** The model in use: its id and when it was trained; null when there is none. The reading is kept per id. */
  training: () => { id: string; trainedAt: string } | null
  /** The stored reading ({ key, learning }) and where to store one. Absent: kept in memory only. */
  stored?: () => unknown
  save?: (r: { key: string; learning: SorterLearning }) => void
}

const UNTRAINED = 'untrained'

const VERDICTS: ReadonlySet<unknown> = new Set(['not-enough', 'still-helping', 'levelling-off'])
const count = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0
const shareOrNull = (x: unknown): x is number | null => x === null || (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1)

/** One stored point, copied out; null when it is not one. */
function storedPoint(p: unknown): SorterLearningPoint | null {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null
  const x = p as Record<string, unknown>
  if (!count(x.choices) || !shareOrNull(x.throwawayRight) || !shareOrNull(x.needALook)) return null
  return { choices: x.choices, throwawayRight: x.throwawayRight, needALook: x.needALook }
}

/**
 * A stored reading for `key`, read strictly: only the fields a reading has are copied out (anything
 * else stored beside them is dropped), every count is a whole number from 0, every share is 0..1,
 * `trainedAt` is null or parses as a date and there are at most MAX_STEPS points. Null when what is
 * stored is for another training or is not a reading (it is then computed again).
 */
export function storedLearning(raw: unknown, key: string): SorterLearning | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as { key?: unknown; learning?: unknown }
  if (r.key !== key || !r.learning || typeof r.learning !== 'object' || Array.isArray(r.learning)) return null
  const l = r.learning as Record<string, unknown>
  if (!VERDICTS.has(l.verdict) || 'error' in l) return null
  const { more, minimum, choices, kept, thrownAway, heldBack } = l
  if (!count(more) || !count(minimum) || !count(choices) || !count(kept) || !count(thrownAway) || !count(heldBack)) return null
  if (!Array.isArray(l.points) || l.points.length > MAX_STEPS) return null
  const points = l.points.map(storedPoint)
  if (points.some((p) => !p)) return null
  if (!(l.trainedAt === null || storedTime(l.trainedAt))) return null
  return { verdict: l.verdict as SorterLearning['verdict'], more, minimum, choices, kept, thrownAway, heldBack, points: points as SorterLearningPoint[], trainedAt: l.trainedAt }
}

export class LearningCurve {
  private cache: { key: string; learning: SorterLearning } | null = null
  private flight: { key: string; done: Promise<SorterLearning> } | null = null
  private abort: AbortController | null = null

  constructor(private deps: LearningDeps) {}

  /** Stop a reading that is being computed (the app is quitting). */
  cancel(): void {
    this.abort?.abort()
  }

  /**
   * The reading for the model in use. Answered from the kept one when there is one for this
   * training; otherwise computed (once: calls made meanwhile get the same answer) and kept. A reading
   * that could not be computed carries `error` and is not kept, so the next call tries again.
   */
  read(): Promise<SorterLearning> {
    let training: { id: string; trainedAt: string } | null = null
    try {
      training = this.deps.training()
    } catch {
      training = null
    }
    const key = training?.id ?? UNTRAINED
    if (this.cache?.key === key) return Promise.resolve(this.cache.learning)
    if (this.flight?.key === key) return this.flight.done
    const kept = storedLearning(this.stored(), key)
    if (kept) {
      this.cache = { key, learning: kept }
      return Promise.resolve(kept)
    }
    const done = this.compute(training?.trainedAt ?? null)
      .then((learning) => {
        if (!learning.error && learning.verdict !== 'not-enough') {
          this.cache = { key, learning }
          try {
            this.deps.save?.({ key, learning })
          } catch {
            /* it stays in memory */
          }
        }
        return learning
      })
      .finally(() => {
        if (this.flight?.done === done) this.flight = null
      })
    this.flight = { key, done }
    return done
  }

  private stored(): unknown {
    try {
      return this.deps.stored?.()
    } catch {
      return null
    }
  }

  private async compute(trainedAt: string | null): Promise<SorterLearning> {
    const ctl = new AbortController()
    this.abort = ctl
    const shots = loadLabelled(this.deps.wellRoot()).filter((s) => s.image && s.truth)
    const kept = shots.filter((s) => s.truth === 'keep').length
    const base: SorterLearning = { verdict: 'not-enough', more: 0, minimum: MIN_CHOICES, choices: shots.length, kept, thrownAway: shots.length - kept, heldBack: 0, points: [], trainedAt }
    const more = moreChoicesNeeded({ kept, binned: shots.length - kept })
    if (more > 0) return { ...base, more }
    const failed = (error: string): SorterLearning => ({ ...base, verdict: 'still-helping', error })
    if (!this.deps.pictures.modelReady()) return failed('download the picture search model first (Settings › Picture search)')
    try {
      const job = <J extends Job>(j: J): Promise<JobResult<J>> => {
        if (ctl.signal.aborted) throw new Error('cancelled')
        return this.deps.runJob ? this.deps.runJob(j, ctl.signal) : Promise.resolve(runJob(j))
      }
      const vectors = await this.deps.pictures.ensureVectors(shots.map((s) => s.image!), { signal: ctl.signal })
      const usable = shots.filter((s) => vectors.has(s.image!.id))
      const vec = (s: Shot): Float32Array => vectors.get(s.image!.id)!
      const grouping = await job({ kind: 'group', items: usable.map((s) => ({ id: s.key, vector: vec(s), app: s.facts.app, windowTitle: s.facts.windowTitle, takenAt: s.takenAt })) })
      const groupOf = (s: Shot): string => grouping.groupOf.get(s.key) ?? s.key
      const { train, test } = holdOutSplit(usable, (s) => s.key, (s) => s.truth ?? '', HOLD_OUT_FRACTION, groupOf)
      if (!test.length || !train.length) return failed('there is nothing to hold back and measure on yet')
      const ordered = nestedOrder(train, (s) => s.key, (s) => s.truth === 'keep')
      const rules = appRuleLookup(storedAppRules(this.deps.appRules?.()))
      const t = this.deps.thresholds ?? DEFAULT_THRESHOLDS
      const testVectors = test.map(vec)
      const points: SorterLearningPoint[] = []
      for (const choices of curveSteps(usable.length)) {
        if (ctl.signal.aborted) throw new Error('cancelled')
        // the same share of the training side as `choices` is of all his choices
        const part = ordered.slice(0, Math.max(1, Math.round((ordered.length * choices) / usable.length)))
        const examples: Example[] = part.map((s) => ({ vector: vec(s), keep: s.truth === 'keep', group: groupOf(s) }))
        try {
          const model = await job({ kind: 'train', examples })
          const tiers = await job({ kind: 'kept-tiers', vectors: testVectors, kept: part.filter((s) => s.truth === 'keep').map(vec) })
          const rows: LabelledPrediction[] = test.map((s, i) => ({ truth: s.truth!, proposal: decide(applyRules(s.facts, rules), predictKeep(model, testVectors[i]), t, tiers[i]).proposal }))
          const a = accuracyReport(rows)
          points.push({ choices, throwawayRight: a.throwaway.precision, needALook: a.doubtful.share })
        } catch (e) {
          if (ctl.signal.aborted) throw e
          points.push({ choices, throwawayRight: null, needALook: null }) // this size cannot be trained
        }
      }
      return { ...base, heldBack: test.length, points, verdict: learningVerdict(points, 0) }
    } catch (e) {
      return failed(ctl.signal.aborted ? 'cancelled' : ((e as Error)?.message ?? String(e)))
    } finally {
      if (this.abort === ctl) this.abort = null
    }
  }
}
