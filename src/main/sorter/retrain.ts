/**
 * Retraining the sorter as he teaches it (ticket 22): one routine for the Train button, the end of a
 * teaching round and the retrain that starts by itself, and the rule for when it starts by itself.
 *
 *   retrain(trigger): train + accuracy test + re-score of his undecided, already proposed screenshots
 *     (service.ts trainAndTest({ rescore: true })), then record what moved as `lastRetrain` (kept in
 *     config, so it is there after a restart). One at a time: a request while one is running joins it.
 *   noteAnswer(): he decided something (Review, Triage, a teaching round). Counted a moment later, off
 *     the call that wrote the decision; several answers in a row are counted once.
 *   By itself: when the answers since the last training reach RETRAIN_EVERY, the switch is on, there
 *     are enough choices to measure a training, and the Mac is on mains power or he allowed battery.
 *     On battery without that, nothing runs: the status says `waitingForPower` and it starts when power
 *     returns (the power seam's on-ac) or when he presses Retrain now. If a sort is running it waits
 *     for the sorter to be idle. A retrain that fails is not tried again until he answers once more.
 *
 * A retrain by itself is a training like any other: it writes a model and its report (so a rule
 * change since the last test is cleared by it), updates existing proposals of undecided screenshots,
 * and nothing else. It makes no sort run, writes no decision of his, and never asks a cloud model.
 *
 * No Electron here: power comes through PowerSeam (index.ts binds powerMonitor), time and deferral
 * through deps.
 */
import type { RetrainTrigger, SorterRetrain, SorterRightShares, SorterTeachStatus } from '../../preload'
import type { AccuracyReport } from './accuracy'
import { answersSince, choicesAtTraining, moreChoicesNeeded, RETRAIN_EVERY, storedTime, type Choices } from './choices'
import { MOVED_HASHES_KEPT, type Rescore } from './rescore'
import { HASH } from '../review/piles'

/** Mains or battery, and a call when mains power returns. */
export type PowerSeam = { onBattery: () => boolean; onAc: (cb: () => void) => void }

export type AutoRetrainSettings = { enabled: boolean; onBattery: boolean }

/** The two switches as stored in config (`sorterAutoRetrain`, `sorterAutoRetrainOnBattery`): on unless stored false; battery off unless stored true. */
export function storedAutoRetrain(raw: { enabled?: unknown; onBattery?: unknown } | null | undefined): AutoRetrainSettings {
  return { enabled: raw?.enabled !== false, onBattery: raw?.onBattery === true }
}

const TRIGGERS: ReadonlySet<unknown> = new Set(['manual', 'round', 'auto'])
const rec = (x: unknown): Record<string, unknown> | null => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null)
const count = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0
const share = (x: unknown): x is number | null => x === null || (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1)
/** Two counts under the names `a` and `b`, copied out; null when either is not a count. */
function pair<A extends string, B extends string>(x: unknown, a: A, b: B): Record<A | B, number> | null {
  const r = rec(x)
  if (!r || !count(r[a]) || !count(r[b])) return null
  return { [a]: r[a], [b]: r[b] } as Record<A | B, number>
}
function shares(x: unknown): SorterRightShares | null {
  const r = rec(x)
  if (!r || !share(r.throwawayRight) || !share(r.keepRight)) return null
  return { throwawayRight: r.throwawayRight, keepRight: r.keepRight }
}

/**
 * A stored SorterRetrain, read strictly: only the fields a record has are copied out (anything else
 * stored beside them is dropped), every count is a whole number from 0, every share is 0..1, `at`
 * parses as a date and there are at most MOVED_HASHES_KEPT hashes, each shaped like a hash. Null
 * when what is stored is not one (nothing is guessed from it).
 */
export function storedRetrain(raw: unknown): SorterRetrain | null {
  const r = rec(raw)
  if (!r || !storedTime(r.at) || !TRIGGERS.has(r.trigger)) return null
  const choices = pair(r.choices, 'before', 'after')
  if (!choices) return null
  const moved = r.needALook !== null || r.movedToSure !== null
  const needALook = moved ? pair(r.needALook, 'before', 'after') : null
  const movedToSure = moved ? pair(r.movedToSure, 'keep', 'throwaway') : null
  if (moved && (!needALook || !movedToSure)) return null
  const acc = rec(r.accuracy)
  if (!acc) return null
  const before = acc.before === null ? null : shares(acc.before)
  const after = shares(acc.after)
  if (!after || (acc.before !== null && !before)) return null
  if (!Array.isArray(r.movedHashes) || r.movedHashes.length > MOVED_HASHES_KEPT || !r.movedHashes.every((h) => typeof h === 'string' && HASH.test(h))) return null
  return { at: r.at, trigger: r.trigger as RetrainTrigger, choices, needALook, movedToSure, accuracy: { before, after }, movedHashes: [...(r.movedHashes as string[])] }
}

const right = (a: AccuracyReport): SorterRightShares => ({ throwawayRight: a.throwaway.precision, keepRight: a.keep.precision })

type Report = { heldBack: AccuracyReport; choicesAtTraining?: number; usable?: { keep: number; throwaway: number } }

/** What one retrain did, for the record. `moved` null: the re-score did not run to the end, so only the accuracy is known. */
export function retrainRecord(at: Date, trigger: RetrainTrigger, before: Report | null | undefined, after: Report, moved: Rescore | null | undefined): SorterRetrain {
  return {
    at: at.toISOString(),
    trigger,
    choices: { before: choicesAtTraining(before) ?? 0, after: choicesAtTraining(after) ?? 0 },
    needALook: moved ? { ...moved.needALook } : null,
    movedToSure: moved ? { ...moved.movedToSure } : null,
    accuracy: { before: before ? right(before.heldBack) : null, after: right(after.heldBack) },
    movedHashes: moved ? moved.movedHashes.slice(0, MOVED_HASHES_KEPT) : []
  }
}

export type RetrainOutcome = { ok: boolean; cancelled?: boolean; report?: Report; error?: string; busy?: true; before?: Report | null; moved?: Rescore | null }

export type RetrainDeps<R extends RetrainOutcome = RetrainOutcome> = {
  /** Train, test and re-score (SorterService.trainAndTest({ rescore: true })). */
  train: () => Promise<R>
  /** His choices counted now and the choices the model in use was trained with (SorterService.choices()). */
  choices: () => { learnable: Choices | null; trainedWith: number | null }
  /** Push the sorter status (SorterService.push()): one of the teaching fields changed. */
  changed: () => void
  power: PowerSeam
  /** The two switches as stored, and where to store them. */
  settings: () => { enabled?: unknown; onBattery?: unknown }
  saveSettings: (s: AutoRetrainSettings) => void
  /** The last retrain as stored (storedRetrain reads it), and where to store one. */
  lastRetrain: () => unknown
  saveLastRetrain: (r: SorterRetrain) => void
  /** One warning line for the log (no screenshot content, no paths). Default: console.warn. */
  log?: (line: string) => void
  /** Run `fn` a moment later, off the current call. Default: a 400 ms timer. */
  defer?: (fn: () => void) => void
  now?: () => Date
}

export class Retrainer<R extends RetrainOutcome = RetrainOutcome> {
  private running: { trigger: RetrainTrigger; done: Promise<R> } | null = null
  /** A count is already scheduled. */
  private scheduled = false
  /** Something asked for a check while a retrain was running: check again when it ends. */
  private again = false
  /** A retrain by itself was refused because the sorter was busy: try when it is idle. */
  private waitingForSorter = false
  /**
   * His choices at the last retrain's end: the number the new model was trained with, or, for one by
   * itself that failed, the number he had then. None starts by itself while he has exactly that many,
   * so a failure is not repeated until he answers again and a training can never follow itself.
   */
  private settledAt: number | null = null

  constructor(private deps: RetrainDeps<R>) {
    deps.power.onAc(() => this.schedule())
  }

  private settings(): AutoRetrainSettings {
    try {
      return storedAutoRetrain(this.deps.settings())
    } catch {
      return storedAutoRetrain(null)
    }
  }

  private lastRetrain(): SorterRetrain | null {
    try {
      return storedRetrain(this.deps.lastRetrain())
    } catch {
      return null
    }
  }

  private onBattery(): boolean {
    try {
      return this.deps.power.onBattery()
    } catch {
      return false // power cannot be read: as on mains
    }
  }

  /** Ten or more answers wait, the switch is on and there are enough choices: a retrain is due. */
  private due(c: { learnable: Choices | null; trainedWith: number | null }, s: AutoRetrainSettings): boolean {
    return s.enabled && answersSince(c.learnable, c.trainedWith) >= RETRAIN_EVERY && moreChoicesNeeded(c.learnable) === 0
  }

  /** The teaching part of the sorter status, from the counts the sorter holds (SorterDeps.teach). */
  status(c: { learnable: Choices | null; trainedWith: number | null }): SorterTeachStatus {
    const s = this.settings()
    const answers = answersSince(c.learnable, c.trainedWith)
    return {
      answersSinceTraining: answers,
      retrainEvery: RETRAIN_EVERY,
      autoRetrain: s.enabled,
      autoRetrainOnBattery: s.onBattery,
      retraining: this.running?.trigger ?? null,
      waitingForPower: !this.running && this.due(c, s) && !s.onBattery && this.onBattery() ? { answers } : null,
      choicesNeeded: moreChoicesNeeded(c.learnable),
      lastRetrain: this.lastRetrain()
    }
  }

  /** He decided something: count again shortly, and retrain if that makes one due. */
  noteAnswer(): void {
    this.schedule()
  }

  /** The sorter's status went out: when it is idle again, a retrain that was waiting for it is looked at again. */
  sorterStatus(phase: string): void {
    if (!this.waitingForSorter || this.running || (phase !== 'idle' && phase !== 'error')) return
    this.waitingForSorter = false
    this.schedule()
  }

  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    const run = (): void => {
      this.scheduled = false
      this.check()
    }
    if (this.deps.defer) this.deps.defer(run)
    else setTimeout(run, 400)
  }

  /** Count his choices, start a retrain if one is due and may run, and push the status either way. */
  private check(): void {
    if (this.running) {
      this.again = true
      return
    }
    let c: { learnable: Choices | null; trainedWith: number | null }
    try {
      c = this.deps.choices()
    } catch {
      return
    }
    const s = this.settings()
    const total = c.learnable ? c.learnable.kept + c.learnable.binned : 0
    const may = this.due(c, s) && (s.onBattery || !this.onBattery()) && this.settledAt !== total
    if (may) void this.retrain('auto').catch(() => undefined)
    else this.deps.changed()
  }

  /**
   * Train, test, re-score, record what moved. 'manual' = Train or Retrain now, 'round' = the end of a
   * teaching round, 'auto' = by itself. While one is running, another request gets the running one's
   * result rather than starting a second.
   */
  retrain(trigger: RetrainTrigger): Promise<R> {
    if (this.running) return this.running.done
    const done = this.run(trigger)
    this.running = { trigger, done }
    this.deps.changed()
    return done
  }

  private async run(trigger: RetrainTrigger): Promise<R> {
    await Promise.resolve() // `running` is set before the training starts and pushes its first status
    let result: R | null = null
    try {
      result = await this.deps.train()
      if (result.ok && result.report) {
        this.settledAt = choicesAtTraining(result.report)
        try {
          this.deps.saveLastRetrain(retrainRecord(this.deps.now ? this.deps.now() : new Date(), trigger, result.before, result.report, result.moved))
        } catch (e) {
          // the training itself stands; without the record "what moved" is gone after a restart
          ;(this.deps.log ?? console.warn)(`[sorter] the last retrain could not be saved: ${(e as Error)?.name ?? 'error'}`)
        }
      } else if (trigger === 'auto') {
        if (result.busy) this.waitingForSorter = true
        else if (!result.cancelled) this.settledAt = this.total()
      }
      return result
    } catch (e) {
      if (trigger === 'auto') this.settledAt = this.total()
      throw e
    } finally {
      this.running = null
      // answers given while it ran are counted now (and the status goes out with `retraining` cleared)
      const recheck = this.again || Boolean(result?.ok)
      this.again = false
      if (recheck) this.check()
      else this.deps.changed()
    }
  }

  private total(): number | null {
    try {
      const l = this.deps.choices().learnable
      return l ? l.kept + l.binned : null
    } catch {
      return null
    }
  }

  /**
   * The switches from the renderer: `enabled` and `onBattery`, each a boolean when present; anything
   * else is refused and what is stored stays. A change that makes a waiting retrain allowed starts it.
   */
  setAuto(patch: unknown): { ok: boolean; autoRetrain: boolean; autoRetrainOnBattery: boolean; error?: string } {
    const cur = this.settings()
    const answer = (s: AutoRetrainSettings, error?: string): { ok: boolean; autoRetrain: boolean; autoRetrainOnBattery: boolean; error?: string } => ({ ok: !error, autoRetrain: s.enabled, autoRetrainOnBattery: s.onBattery, ...(error ? { error } : {}) })
    const refused = 'That is not a setting the sorter knows.'
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return answer(cur, refused)
    const p = patch as Record<string, unknown>
    const known = Object.keys(p).every((k) => k === 'enabled' || k === 'onBattery')
    const bool = (x: unknown): boolean => x === undefined || typeof x === 'boolean'
    if (!known || !bool(p.enabled) || !bool(p.onBattery) || (p.enabled === undefined && p.onBattery === undefined)) return answer(cur, refused)
    const next: AutoRetrainSettings = { enabled: (p.enabled as boolean | undefined) ?? cur.enabled, onBattery: (p.onBattery as boolean | undefined) ?? cur.onBattery }
    this.deps.saveSettings(next)
    this.check() // pushes the status, or starts the retrain the change allows
    return answer(next)
  }
}
