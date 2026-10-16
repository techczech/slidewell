/**
 * The screenshot sorter, local part, as one main-process service.
 *
 *   trainAndTest(): embed his labelled history (picture-search engine), hold back 20% of it, train
 *     the classifier on the rest, write the accuracy report on the held-back sample, then train the
 *     model it will use on all of it. Saves model + report (store.ts).
 *   sortUndecided(): for every undecided screenshot in triage: rules + classifier → a proposal with
 *     confidence and reason, recorded in sorter_proposals. Needs a trained model with a report.
 *     Given a period window (period.ts), it looks only at screenshots taken inside it; the rest are
 *     not read, embedded or written.
 *   sortManual(): the "Sort undecided screenshots now" button: sortUndecided for the period chosen in
 *     Settings, with the cut-off worked out here from main's clock. The renderer passes no period.
 *   status(): besides the run in progress and the report, three things worked out here and nowhere
 *     else: the last sort as numbers (kept in config, so it is there after a restart), how many
 *     undecided screenshots there are (in the chosen period and in all), and how many of his choices
 *     the sorter can learn from. The two counts read every row and look at every file, so they are
 *     taken only when asked for (the status call from the renderer), after a sort and when the period
 *     changes; a status pushed in between carries the last count.
 *
 * Every sort that starts gets a run record (runs.ts) and its proposals carry the run's id, so the tab
 * can show what one sort did. His per-app rules (app-rules.ts, kept in config) join the built-in rules
 * in training's test and in sorting; changing one sorts nothing. The report records which rules it was
 * measured with (a fingerprint). While his rules differ from those, "Sort now" still works (he is
 * there and sees the piles) but sorting unattended is refused, as with too little evidence, until he
 * trains again: status() says so in `rulesChangedSinceTest` and `canRunUnattended` is false.
 *
 * Teaching (ticket 22): trainAndTest({ rescore: true }) also scores the doubtful proposals among his
 * undecided screenshots again with the new model and says what moved (rescore.ts; no sort run, no decision, no
 * cloud call), inside the same busy window so no sort can start in between. retrain.ts decides when a
 * training runs by itself and supplies the teaching part of the status (deps.teach).
 *
 * Sorting writes proposals only: it never moves, deletes or decides anything (binning is later
 * work), and it never writes his triage decisions. Nothing here makes a network call: the cloud step
 * (cloud/service.ts) runs after it. Each proposal records which step made the call (cloud/cascade.ts);
 * a doubtful screenshot a cloud model (Luna or Haiku) already answered gets that answer again here, in
 * the same write, so a re-sort neither asks twice nor restarts a throwaway's 30-day clock.
 */
import { ipcMain } from 'electron'
import type { IndexItem } from '../picture-search/vector-store'
import type { SorterTeachStatus } from '../../preload'
import { applyRules } from './rules'
import { predictKeep, type Classifier, type Example } from './classifier'
import { runJob, type Job, type JobResult } from './jobs'
import { auc, brier, reliabilityTable, type CalibrationCheck, type ReliabilityRow } from './calibration'
import { decide, DEFAULT_THRESHOLDS, SORTER_VERSION, type Thresholds } from './decide'
import { accuracyReport, enoughToMeasure, holdOutSplit, HOLD_OUT_FRACTION, MIN_HELD_BACK, type AccuracyReport, type LabelledPrediction } from './accuracy'
import { loadLabelled, loadUndecided, SorterStore, type ProposalRow, type Shot } from './store'
import { answerScopes } from './cloud/provider'
import { scoreShot } from './score'
import { rescoreUndecided, type Rescore } from './rescore'
import { choicesAtTraining, teachDefaults, type Choices } from './choices'
import { appRuleLookup, appRulesFingerprint, NO_APP_RULES, storedAppRules, type AppRule } from './app-rules'
import { newRunId, type RunTrigger } from './runs'
import type { AppRuleLookup } from './rules'
import { EVERYTHING, inWindow, isSortPeriod, PERIOD_CHOICES, PERIOD_REFUSED, PERIOD_UNREADABLE, periodPhrase, periodWindow, storedPeriod, type PeriodWindow, type SortPeriod } from './period'

export { HOLD_OUT_FRACTION }

export type SorterReport = {
  trainedAt: string
  sorterVersion: string
  thresholds: Thresholds
  holdOutFraction: number
  /** Labelled screenshots found / with a readable picture. */
  labelled: { keep: number; throwaway: number }
  usable: { keep: number; throwaway: number }
  /** Kept screenshots embedded from the well's copy because the original is gone. */
  keepFromWellCopy: number
  /** Related screenshots grouped before splitting (cosine ≥ 0.95, or same app + window within 5 min). */
  grouping: { groups: number; largest: number; cosine: number; minutes: number }
  /** The held-back sample is big enough (MIN_HELD_BACK) for the sorter to run unattended. */
  enoughToMeasure: boolean
  /** His choices with a readable picture when this was trained (choices.ts answersSince counts from it). Absent on an older report. */
  choicesAtTraining?: number
  /** His per-app rules as they were when this was measured (app-rules.ts appRulesFingerprint). Absent on a report from before it was recorded: no rules. */
  appRulesFingerprint?: string
  /** The classifier tested on the held-back sample was trained on this many. */
  trainedOn: { keep: number; throwaway: number }
  l2: number
  /** Calibration chosen inside the training split (cross-validated Brier + reliability of both methods). */
  calibration: CalibrationCheck | null
  /** The calibrated classifier alone on the held-back sample. */
  heldBackClassifier: { auc: number | null; brier: number; reliability: ReliabilityRow[] }
  /** Rules + classifier on the held-back sample (the number that matters). */
  heldBack: AccuracyReport
  /** Rules alone on the same sample, for comparison. */
  rulesOnly: AccuracyReport
}

export type SorterStatus = {
  phase: 'idle' | 'embedding' | 'training' | 'sorting' | 'error'
  done: number
  total: number
  message: string
  error: string | null
  modelReady: boolean
  report: SorterReport | null
  /** A held-back report with enough items of each label exists, measured with his app rules as they are now, so sorting may run without him watching. */
  canRunUnattended: boolean
  /** A model exists but was trained under an older sorter version: sorting is refused until retrained. */
  retrainNeeded: boolean
  /**
   * A current model and report exist, but his app rules have changed since the report was measured: it
   * no longer describes what a sort does. "Sort now" still works; unattended sorting is refused until
   * he trains again. False when there is no current model (retrainNeeded or nothing trained says that).
   */
  rulesChangedSinceTest: boolean
  /** The least held-back evidence needed (shown in Settings when there is not enough yet). */
  minHeldBack: { total: number; perLabel: number }
  pending: { keep: number; throwaway: number; doubtful: number; lastProposedAt: string | null }
  /** The period a manual sort is limited to (one setting for both sort buttons); null when the stored one cannot be read. */
  period: SortPeriod | null
  /** The periods that can be chosen, in the order shown. */
  periods: ReadonlyArray<{ id: SortPeriod; label: string }>
  /** The last sort on this Mac as numbers (whichever button or the nightly batch started it); null when none is recorded. */
  lastRun: LocalRunSummary | null
  /**
   * Undecided screenshots a sort would look at: in the chosen period (`period`; `inPeriod` is null
   * when the stored period cannot be read) and in all. Null until first counted.
   */
  undecided: { period: SortPeriod | null; inPeriod: number | null; all: number } | null
  /** His choices the sorter can learn from: kept and binned screenshots with a readable picture on this Mac. Null until first counted. */
  learnable: { kept: number; binned: number } | null
} & SorterTeachStatus

/** What a training answers. `before`: the current report it replaces (null = none); `moved`: the re-score, when asked for and it ran to the end (null: it failed or was stopped, so what moved is not known). */
export type TrainResult = { ok: boolean; cancelled?: boolean; report?: SorterReport; error?: string; /** Refused because the sorter was already running. */ busy?: true; before?: SorterReport | null; moved?: Rescore | null }

export const SORTER_BUSY = 'the sorter is already running'

/** One sort on this Mac as numbers: when it ended, the period it was limited to, how many it looked at, and of those how many got a keep or throwaway proposal and how many stayed doubtful. */
export type LocalRunSummary = { at: string; period: SortPeriod; lookedAt: number; confident: number; needLook: number; /** Left out because not on this Mac (only when the switch was on and some were). */ notOnMacSkipped?: number }

/** A stored LocalRunSummary; null when what is stored is not one (nothing is guessed from it). */
export function storedLocalRun(raw: unknown): LocalRunSummary | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const n = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0
  if (typeof r.at !== 'string' || !Number.isFinite(Date.parse(r.at)) || !isSortPeriod(r.period) || !n(r.lookedAt) || !n(r.confident) || !n(r.needLook)) return null
  return { at: r.at, period: r.period, lookedAt: r.lookedAt, confident: r.confident, needLook: r.needLook, ...(n(r.notOnMacSkipped) && r.notOnMacSkipped > 0 ? { notOnMacSkipped: r.notOnMacSkipped } : {}) }
}

export type SortResult = {
  ok: boolean
  sorted?: number
  counts?: { keep: number; throwaway: number; doubtful: number }
  error?: string
  /** The period this run was limited to, and it inside a sentence (' from the last 30 days'; '' for everything). */
  period?: SortPeriod
  periodPhrase?: string
  /** Screenshots left out because their file is not on this Mac (the Review switch is on); absent when none were. */
  notOnMacSkipped?: number
}

export type SorterDeps = {
  wellRoot: () => string
  pictures: {
    modelReady: () => boolean
    ensureVectors: (items: IndexItem[], opts: { signal?: AbortSignal; onEach?: (done: number, total: number) => void }) => Promise<Map<string, Float32Array>>
  }
  broadcast: (s: SorterStatus) => void
  thresholds?: Thresholds
  /**
   * Runs a CPU-bound training job (jobs.ts: grouping, fitting); the app passes a worker thread so the
   * main process never blocks. When `signal` aborts, the job must stop (terminate the worker) and reject.
   */
  runJob?: <J extends Job>(job: J, signal: AbortSignal) => Promise<JobResult<J>>
  /** The period stored in config, as stored (period.ts storedPeriod reads it). Absent: everything. */
  period?: () => unknown
  /** The last sort as stored in config (storedLocalRun reads it), and where to store one. Absent: none is kept. */
  lastRun?: () => unknown
  saveLastRun?: (r: LocalRunSummary) => void
  /** His per-app rules as stored in config (app-rules.ts storedAppRules reads them). Absent: none. */
  appRules?: () => unknown
  /**
   * The teaching part of the status (retrain.ts Retrainer.status), from his choices as last counted and
   * the choices the model in use was trained with (null: no current model). Absent: teachDefaults.
   */
  teach?: (c: { learnable: Choices | null; trainedWith: number | null }) => SorterTeachStatus
  /** Review's "leave screenshots that are not on this Mac out of Review and sorting" (config). On: a sort skips them. */
  skipNotOnMac?: () => boolean
  /** A cloud placeholder on disk (store.ts loadUndecided); a test seam. */
  dataless?: (abs: string) => boolean
  /** One warning line for the log (no screenshot content, no paths). Default: console.warn. */
  log?: (line: string) => void
  now?: () => Date
}

/** A model counts only when it and its report were made under the current sorter version. */
function isCurrent(rec: { sorterVersion: string; report: { sorterVersion?: string } }): boolean {
  return rec.sorterVersion === SORTER_VERSION && rec.report?.sorterVersion === SORTER_VERSION
}

/** The app rules the report was measured with are the ones in force now. */
function testedWith(report: { appRulesFingerprint?: unknown }, rules: AppRule[]): boolean {
  const then = typeof report?.appRulesFingerprint === 'string' ? report.appRulesFingerprint : NO_APP_RULES
  return then === appRulesFingerprint(rules)
}

export const RULES_CHANGED = 'the app rules changed since the sorter was last tested; train it again before it sorts on its own'

type Run = Pick<SorterStatus, 'phase' | 'done' | 'total' | 'message' | 'error'>

export class SorterService {
  private run: Run = { phase: 'idle', done: 0, total: 0, message: '', error: null }
  private abort: AbortController | null = null
  private lastPush = 0
  /** The two counts as last taken (count()); null until then. */
  private counts: Pick<SorterStatus, 'undecided' | 'learnable'> = { undecided: null, learnable: null }

  constructor(private deps: SorterDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date()
  }

  /**
   * Count the undecided screenshots and his usable choices now. The undecided ones are the list a
   * sort reads (loadUndecided) under the window a manual sort would use (period.ts), so the number is
   * the number a sort would look at. If either cannot be read, the last count stays.
   */
  private count(): void {
    try {
      const period = this.period()
      const window = period ? periodWindow(period, this.now()) : null
      const skip = this.skipNotOnMac()
      const undecided = loadUndecided(this.deps.wellRoot(), this.deps.dataless).filter((s) => !(skip && s.notOnMac))
      const labelled = loadLabelled(this.deps.wellRoot()).filter((s) => s.image)
      this.counts = {
        undecided: { period, inPeriod: window ? undecided.filter((s) => inWindow(s.takenAt, window)).length : null, all: undecided.length },
        learnable: { kept: labelled.filter((s) => s.truth === 'keep').length, binned: labelled.filter((s) => s.truth === 'throwaway').length }
      }
    } catch {
      /* the last count stays */
    }
  }

  private skipNotOnMac(): boolean {
    try {
      return this.deps.skipNotOnMac?.() === true
    } catch {
      return false
    }
  }

  private lastRun(): LocalRunSummary | null {
    try {
      return storedLocalRun(this.deps.lastRun?.())
    } catch {
      return null
    }
  }

  /** His per-app rules as they are now (read once per training or sort, so the fingerprint and the lookup are of the same rules). */
  private appRules(): AppRule[] {
    return storedAppRules(this.deps.appRules?.())
  }

  private thresholds(): Thresholds {
    return this.deps.thresholds ?? DEFAULT_THRESHOLDS
  }

  private withStore<T>(fn: (s: SorterStore) => T): T {
    const s = new SorterStore(this.deps.wellRoot())
    try {
      return fn(s)
    } finally {
      s.close()
    }
  }

  /** `count: true` takes the two counts afresh (the renderer's status call); otherwise the status carries the last ones. */
  status(opts: { count?: boolean } = {}): SorterStatus {
    if (opts.count) this.count()
    const { rec, pending } = this.withStore((s) => ({ rec: s.latestModel<SorterReport>(), pending: s.pendingCounts() }))
    const current = rec ? isCurrent(rec) : false
    const report = current ? rec!.report : null
    const rulesChangedSinceTest = current && !testedWith(rec!.report, this.appRules())
    const teach = { learnable: this.counts.learnable, trainedWith: current ? choicesAtTraining(rec!.report) : null }
    return { ...(this.deps.teach ? this.deps.teach(teach) : teachDefaults(teach)), ...this.run, modelReady: this.deps.pictures.modelReady(), report, canRunUnattended: current && enoughToMeasure(report?.heldBack) && !rulesChangedSinceTest, retrainNeeded: Boolean(rec) && !current, rulesChangedSinceTest, minHeldBack: MIN_HELD_BACK, pending, period: this.period(), periods: PERIOD_CHOICES, lastRun: this.lastRun(), ...this.counts }
  }

  /**
   * A sort can run at all: a current model with enough held-back evidence, and the picture model on
   * this Mac. His app rules are not part of this (rulesChangedSinceTest); a sort he starts himself
   * needs only this.
   */
  canSort(): boolean {
    const rec = this.withStore((s) => s.latestModel<SorterReport>())
    return Boolean(rec) && isCurrent(rec!) && enoughToMeasure(rec!.report.heldBack) && this.deps.pictures.modelReady()
  }

  /** A current model exists and his app rules are not the ones its report was measured with (status() gives the same). */
  rulesChangedSinceTest(): boolean {
    const rec = this.withStore((s) => s.latestModel<SorterReport>())
    return Boolean(rec) && isCurrent(rec!) && !testedWith(rec!.report, this.appRules())
  }

  /** His choices counted afresh, and the choices the model in use was trained with (null: no current model). For retrain.ts. */
  choices(): { learnable: Choices | null; trainedWith: number | null } {
    this.count()
    const rec = this.withStore((s) => s.latestModel<SorterReport>())
    return { learnable: this.counts.learnable, trainedWith: rec && isCurrent(rec) ? choicesAtTraining(rec.report) : null }
  }

  /** Push the status as it is, with the counts last taken (a teaching setting or state changed). */
  push(): void {
    this.deps.broadcast(this.status())
  }

  /** The period chosen in Settings; null when what is stored is not a period. */
  period(): SortPeriod | null {
    return storedPeriod(this.deps.period ? this.deps.period() : undefined)
  }

  /** Push the status again (the period was changed, so the count for the period is taken again). */
  notify(): void {
    this.deps.broadcast(this.status({ count: true }))
  }

  /**
   * "Sort undecided screenshots now": the period chosen in Settings, its cut-off taken from this
   * process's clock. Nothing is sorted when the stored period cannot be read.
   */
  async sortManual(opts: { limit?: number } = {}): Promise<SortResult> {
    const p = this.period()
    const window = p ? periodWindow(p, this.now()) : null
    if (!window) return { ok: false, error: PERIOD_UNREADABLE }
    return this.sortUndecided({ ...opts, window })
  }

  private set(patch: Partial<Run>, force = false): void {
    this.run = { ...this.run, ...patch }
    const now = Date.now()
    if (!force && now - this.lastPush < 250) return
    this.lastPush = now
    this.deps.broadcast(this.status())
  }

  private busy(): boolean {
    return this.run.phase === 'embedding' || this.run.phase === 'training' || this.run.phase === 'sorting'
  }

  cancel(): void {
    this.abort?.abort()
  }

  private async vectorsFor(shots: Shot[], label: string, signal: AbortSignal): Promise<Map<string, Float32Array>> {
    const items = shots.flatMap((s) => (s.image ? [s.image] : []))
    this.set({ phase: 'embedding', done: 0, total: items.length, message: label }, true)
    return this.deps.pictures.ensureVectors(items, { signal, onEach: (done, total) => this.set({ done, total }) })
  }

  /**
   * Train on his history and report accuracy on a held-back 20%. Returns the report. With
   * `rescore`, the doubtful proposals among his undecided screenshots are then scored again with the
   * new model (rescore.ts; a proposal the sorter was sure about is not touched) before the sorter is
   * idle again; if that fails or is stopped part-way the training still stands and `moved` is null
   * (rows a stopped re-score had already written stay).
   */
  async trainAndTest(opts: { rescore?: boolean } = {}): Promise<TrainResult> {
    if (this.busy()) return { ok: false, error: SORTER_BUSY, busy: true }
    if (!this.deps.pictures.modelReady()) return { ok: false, error: 'download the picture search model first (Settings › Picture search)' }
    const ctl = new AbortController()
    this.abort = ctl
    try {
      const prior = this.withStore((s) => s.latestModel<SorterReport>())
      const before = prior && isCurrent(prior) ? prior.report : null
      const shots = loadLabelled(this.deps.wellRoot())
      const vectors = await this.vectorsFor(shots, 'reading pictures of your past choices', ctl.signal)
      if (ctl.signal.aborted) throw new Error('cancelled')
      this.set({ phase: 'training', message: 'grouping related screenshots' }, true)
      const usable = shots.filter((s) => s.image && vectors.has(s.image.id))
      const job = <J extends Job>(j: J): Promise<JobResult<J>> => {
        if (ctl.signal.aborted) throw new Error('cancelled')
        return this.deps.runJob ? this.deps.runJob(j, ctl.signal) : Promise.resolve(runJob(j))
      }
      // related screenshots stay together: on one side of the split and in one fold
      const grouping = await job({ kind: 'group', items: usable.map((s) => ({ id: s.key, vector: vectors.get(s.image!.id)!, app: s.facts.app, windowTitle: s.facts.windowTitle, takenAt: s.takenAt })) })
      if (ctl.signal.aborted) throw new Error('cancelled')
      this.set({ message: 'learning from your past choices' }, true)
      const groupOf = (s: Shot): string => grouping.groupOf.get(s.key) ?? s.key
      const { train: trainSet, test } = holdOutSplit(
        usable,
        (s) => s.key,
        (s) => s.truth ?? '',
        HOLD_OUT_FRACTION,
        groupOf
      )
      const toExamples = (xs: Shot[]): Example[] => xs.map((s) => ({ vector: vectors.get(s.image!.id)!, keep: s.truth === 'keep', group: groupOf(s) }))
      const fitModel = (xs: Example[]): Promise<Classifier> => job({ kind: 'train', examples: xs })
      const held: Classifier = await fitModel(toExamples(trainSet))
      if (ctl.signal.aborted) throw new Error('cancelled')
      const t = this.thresholds()
      const both: LabelledPrediction[] = []
      const rulesAlone: LabelledPrediction[] = []
      const scored: Array<{ p: number; keep: boolean }> = []
      // the look-alike signal as it will run: a held-back screenshot against the kept ones it was trained beside
      const trainKept = trainSet.filter((s) => s.truth === 'keep').map((s) => vectors.get(s.image!.id)!)
      const testTiers = await job({ kind: 'kept-tiers', vectors: test.map((s) => vectors.get(s.image!.id)!), kept: trainKept }) // in the worker
      if (ctl.signal.aborted) throw new Error('cancelled')
      const rules = this.appRules()
      const mine: AppRuleLookup = appRuleLookup(rules)
      for (const [ti, s] of test.entries()) {
        const rule = applyRules(s.facts, mine)
        const v = vectors.get(s.image!.id)!
        const p = predictKeep(held, v)
        scored.push({ p, keep: s.truth === 'keep' })
        both.push({ truth: s.truth!, proposal: decide(rule, p, t, testTiers[ti]).proposal })
        rulesAlone.push({ truth: s.truth!, proposal: decide(rule, null, t).proposal })
      }
      // the report measures the procedure on the held-back fifth; the model in use is then retrained on
      // all of his choices, its calibration again from out-of-fold (group k-fold) scores, never in-sample
      const final = await fitModel(toExamples(usable))
      if (ctl.signal.aborted) throw new Error('cancelled')
      const trainedAt = new Date().toISOString()
      const count = (xs: Shot[]): { keep: number; throwaway: number } => ({ keep: xs.filter((s) => s.truth === 'keep').length, throwaway: xs.filter((s) => s.truth === 'throwaway').length })
      const report: SorterReport = {
        trainedAt,
        sorterVersion: SORTER_VERSION,
        thresholds: t,
        holdOutFraction: HOLD_OUT_FRACTION,
        labelled: count(shots),
        usable: count(usable),
        keepFromWellCopy: usable.filter((s) => s.fromWellCopy).length,
        grouping: { groups: grouping.groups, largest: grouping.largest, cosine: 0.95, minutes: 5 },
        enoughToMeasure: false,
        choicesAtTraining: shots.filter((s) => s.image).length,
        appRulesFingerprint: appRulesFingerprint(rules),
        trainedOn: held.trainedOn,
        l2: held.l2,
        calibration: held.calibrationCheck ?? null,
        heldBackClassifier: { auc: auc(scored), brier: brier(scored), reliability: reliabilityTable(scored.map((x) => ({ pThrow: 1 - x.p, binned: !x.keep }))) },
        heldBack: accuracyReport(both),
        rulesOnly: accuracyReport(rulesAlone)
      }
      report.enoughToMeasure = enoughToMeasure(report.heldBack)
      if (ctl.signal.aborted) throw new Error('cancelled') // last check before anything is saved
      const modelId = `model-${trainedAt}`
      this.withStore((s) => s.saveModel({ id: modelId, trainedAt, sorterVersion: SORTER_VERSION, model: final, report }))
      let moved: Rescore | null = null
      const warn = this.deps.log ?? ((line: string): void => console.warn(line))
      if (opts.rescore) {
        this.set({ message: 'checking which undecided screenshots moved', done: 0, total: 0 }, true)
        try {
          moved = await rescoreUndecided({
            wellRoot: this.deps.wellRoot(),
            model: final,
            modelId,
            sorterVersion: SORTER_VERSION,
            thresholds: t,
            rules: mine,
            asked: this.withStore((st) => st.cloudAnswersIn(answerScopes())),
            vectors: (items) => this.deps.pictures.ensureVectors(items, { signal: ctl.signal }),
            keptVectors: usable.filter((s) => s.truth === 'keep').map((s) => vectors.get(s.image!.id)!),
            job,
            aborted: () => ctl.signal.aborted,
            onProgress: (done, total) => this.set({ done, total })
          })
          if (ctl.signal.aborted) {
            // the rows written so far stay (they are valid scores from the new model), but the counts
            // are of a part only: what moved is reported as not checked, never as a partial number
            warn(`[sorter] the re-score after training was stopped after ${moved.rescored} proposals; the rest keep their earlier scores`)
            moved = null
          }
        } catch (e) {
          moved = null // the model is saved; what moved is simply not known
          warn(ctl.signal.aborted ? '[sorter] the re-score after training was stopped; proposals keep their earlier scores' : `[sorter] the re-score after training failed (${(e as Error)?.name ?? 'error'}); proposals keep their earlier scores`)
        }
      }
      this.set({ phase: 'idle', done: 0, total: 0, message: '', error: null }, true)
      return { ok: true, report, before, moved }
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      this.set({ phase: ctl.signal.aborted ? 'idle' : 'error', message: '', error: ctl.signal.aborted ? null : msg }, true)
      return ctl.signal.aborted ? { ok: false, cancelled: true, error: 'cancelled' } : { ok: false, error: msg }
    } finally {
      this.abort = null
    }
  }

  /**
   * Propose keep / throwaway / doubtful for every undecided screenshot, or, given a period window,
   * for those taken inside it (period.ts inWindow; one with no date in its name is inside Everything
   * only). Writes proposals only, and none for a screenshot outside the window. `trigger` says who
   * started it, for the run record (the nightly batch passes 'nightly'). A nightly sort is refused when
   * his app rules are not the ones the report was measured with; one he started himself is not.
   */
  async sortUndecided(opts: { limit?: number; window?: PeriodWindow; trigger?: RunTrigger } = {}): Promise<SortResult> {
    const window = opts.window ?? EVERYTHING
    if (!isSortPeriod(window.period)) return { ok: false, error: PERIOD_REFUSED }
    const within = { period: window.period, periodPhrase: periodPhrase(window.period) }
    if (this.busy()) return { ok: false, error: SORTER_BUSY }
    const rec = this.withStore((s) => s.latestModel<SorterReport>())
    if (!rec) return { ok: false, error: 'train the sorter on your past choices first; it needs an accuracy report before it sorts' }
    if (!isCurrent(rec)) return { ok: false, error: 'retrain needed: the sorter changed since it was last trained' }
    if (!enoughToMeasure(rec.report.heldBack)) return { ok: false, error: 'not enough of your past choices to measure accuracy yet' }
    // read once: the rules checked against the report are the rules this sort then uses
    const rules = this.appRules()
    if (opts.trigger === 'nightly' && !testedWith(rec.report, rules)) return { ok: false, error: RULES_CHANGED }
    if (!this.deps.pictures.modelReady()) return { ok: false, error: 'download the picture search model first (Settings › Picture search)' }
    const ctl = new AbortController()
    this.abort = ctl
    const counts = { keep: 0, throwaway: 0, doubtful: 0 }
    let sorted = 0
    let notOnMacSkipped = 0
    const started = this.now()
    const runId = newRunId(started)
    // a sort that ended (or was stopped) is recorded as numbers and the counts are taken again, before the last status goes out
    const record = (): void => {
      try {
        this.withStore((st) => st.finishRun(runId, { finishedAt: this.now().toISOString(), counts: { sorted, ...counts } }))
      } catch {
        /* the sort itself stands */
      }
      try {
        this.deps.saveLastRun?.({ at: this.now().toISOString(), period: window.period, lookedAt: sorted, confident: counts.keep + counts.throwaway, needLook: counts.doubtful, ...(notOnMacSkipped ? { notOnMacSkipped } : {}) })
      } catch {
        /* the sort itself stands */
      }
      this.count()
    }
    try {
      this.withStore((st) => st.startRun({ id: runId, startedAt: started.toISOString(), period: window.period, trigger: opts.trigger === 'nightly' ? 'nightly' : 'manual' }))
      const ctx = { model: rec.model, thresholds: this.thresholds(), rules: appRuleLookup(rules), asked: new Map() as ReturnType<SorterStore['cloudAnswersIn']> }
      let shots = loadUndecided(this.deps.wellRoot(), this.deps.dataless).filter((s) => inWindow(s.takenAt, window))
      // Review's switch: screenshots whose file is a cloud placeholder wait until they are downloaded (counted, not sorted)
      if (this.skipNotOnMac()) {
        const here = shots.filter((s) => !s.notOnMac)
        notOnMacSkipped = shots.length - here.length
        shots = here
      }
      if (opts.limit !== undefined) shots = shots.slice(0, Math.max(0, opts.limit))
      // pictures of everything he kept: a look-alike of one of them leans throwaway
      const keptShots = loadLabelled(this.deps.wellRoot()).filter((s) => s.truth === 'keep' && s.image)
      const keptVectors = [...(await this.vectorsFor(keptShots, 'reading pictures of what you kept', ctl.signal)).values()]
      // answers already given by either cloud provider under its current model and prompt
      ctx.asked = this.withStore((st) => st.cloudAnswersIn(answerScopes()))
      this.set({ phase: 'sorting', done: 0, total: shots.length, message: 'sorting undecided screenshots', error: null }, true)
      const CHUNK = 25
      for (let i = 0; i < shots.length && !ctl.signal.aborted; i += CHUNK) {
        const chunk = shots.slice(i, i + CHUNK)
        const items = chunk.flatMap((s) => (s.image ? [s.image] : []))
        const vectors = await this.deps.pictures.ensureVectors(items, { signal: ctl.signal })
        const rows: ProposalRow[] = []
        // the copy-of-kept scan runs in the worker, so the main process stays responsive while sorting
        const have = chunk.filter((s) => s.image && vectors.has(s.image.id))
        if (ctl.signal.aborted) break
        const tiers = have.length ? await (this.deps.runJob ? this.deps.runJob({ kind: 'kept-tiers', vectors: have.map((s) => vectors.get(s.image!.id)!), kept: keptVectors }, ctl.signal) : Promise.resolve(runJob({ kind: 'kept-tiers', vectors: have.map((s) => vectors.get(s.image!.id)!), kept: keptVectors }))) : []
        const tierOf = new Map(have.map((s, k) => [s, tiers[k]]))
        for (const s of chunk) {
          if (!s.hash) continue
          const v = s.image ? vectors.get(s.image.id) : undefined
          if (s.image && !v && ctl.signal.aborted) continue // not reached before cancel: no proposal
          const row = scoreShot({ facts: s.facts, hash: s.hash }, v, v ? (tierOf.get(s) ?? null) : null, ctx)
          rows.push(row)
          counts[row.proposal]++
        }
        this.withStore((st) => st.writeProposals(rows, SORTER_VERSION, rec.id, runId))
        sorted += rows.length
        this.set({ done: Math.min(shots.length, i + chunk.length) })
      }
      record()
      this.set({ phase: 'idle', done: 0, total: 0, message: '' }, true)
      return { ok: true, sorted, counts, ...within, ...(notOnMacSkipped ? { notOnMacSkipped } : {}) }
    } catch (e) {
      if (ctl.signal.aborted) {
        // Stop ended the worker mid-chunk: proposals already written stay, nothing more is recorded
        record()
        this.set({ phase: 'idle', done: 0, total: 0, message: '' }, true)
        return { ok: true, sorted, counts, ...within, ...(notOnMacSkipped ? { notOnMacSkipped } : {}) }
      }
      const msg = (e as Error)?.message ?? String(e)
      try {
        // the run that failed is closed with what it had sorted; lastRun is not written for a failed sort, as before
        this.withStore((st) => st.finishRun(runId, { finishedAt: this.now().toISOString(), counts: { sorted, ...counts } }))
      } catch {
        /* the error below is the one reported */
      }
      this.set({ phase: 'error', message: '', error: msg }, true)
      return { ok: false, sorted, counts, error: msg, ...within, ...(notOnMacSkipped ? { notOnMacSkipped } : {}) }
    } finally {
      this.abort = null
    }
  }
}

/**
 * What the cloud step (cloud/service.ts CloudDeps) is told about the local sorter, as two separate
 * answers: whether a sort can run at all, and whether his app rules have changed since the report.
 * The nightly batch needs the first and refuses on the second; Sort now needs only the first.
 */
export function cloudGates(svc: SorterService): { canSortLocal: () => boolean; rulesChangedSinceTest: () => boolean } {
  return { canSortLocal: () => svc.canSort(), rulesChangedSinceTest: () => svc.rulesChangedSinceTest() }
}

/**
 * A period chosen in Settings. Only one of the four period ids is stored; anything else is refused
 * and what is stored stays as it was (it is never read as Everything). `changed` runs after a
 * different period was stored (index.ts: the cloud step drops its prepared batch).
 */
export function changePeriod(period: unknown, current: () => unknown, save: (p: SortPeriod) => void, changed: () => void): { ok: boolean; period: SortPeriod | null; error?: string } {
  if (!isSortPeriod(period)) return { ok: false, period: storedPeriod(current()), error: PERIOD_REFUSED }
  const before = storedPeriod(current())
  save(period)
  if (before !== period) changed()
  return { ok: true, period }
}

/**
 * IPC for Settings › Screenshot sorter. Types: src/preload/index.ts. `sorter:sort` takes no period
 * and no date: the period is the stored one and the cut-off is main's. `setPeriod` is changePeriod
 * bound to the config (index.ts).
 */
export function registerSorterIpc(
  svc: SorterService,
  allowed: (sender: Electron.WebContents) => boolean,
  setPeriod: (period: unknown) => { ok: boolean; period: SortPeriod | null; error?: string } = () => ({ ok: false, period: svc.period(), error: PERIOD_REFUSED }),
  /** What "Train" runs: the app passes the retrain routine (retrain.ts), so a manual training also says what moved. */
  train: () => Promise<TrainResult> = () => svc.trainAndTest()
): void {
  const handle = (channel: string, fn: (...args: any[]) => unknown): void => { // eslint-disable-line @typescript-eslint/no-explicit-any
    ipcMain.handle(channel, (e, ...args) => {
      if (!allowed(e.sender)) throw new Error(`${channel}: not allowed from this window`)
      return fn(...args)
    })
  }
  handle('sorter:status', () => svc.status({ count: true }))
  handle('sorter:train', () => train())
  handle('sorter:sort', (opts?: { limit?: number }) => svc.sortManual({ limit: typeof opts?.limit === 'number' ? opts.limit : undefined }))
  handle('sorter:set-period', (period: unknown) => setPeriod(period))
  handle('sorter:cancel', () => svc.cancel())
}
