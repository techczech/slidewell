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
 *
 * Sorting writes proposals only: it never moves, deletes or decides anything (binning is later
 * work), and it never writes his triage decisions. Nothing here makes a network call: the cloud step
 * (cloud/service.ts) runs after it. Each proposal records which step made the call (cloud/cascade.ts);
 * a doubtful screenshot a cloud model (Luna or Haiku) already answered gets that answer again here, in
 * the same write, so a re-sort neither asks twice nor restarts a throwaway's 30-day clock.
 */
import { ipcMain } from 'electron'
import type { IndexItem } from '../picture-search/vector-store'
import { applyRules } from './rules'
import { predictKeep, type Classifier, type Example } from './classifier'
import { runJob, type Job, type JobResult } from './jobs'
import { auc, brier, reliabilityTable, type CalibrationCheck, type ReliabilityRow } from './calibration'
import { decide, DEFAULT_THRESHOLDS, SORTER_VERSION, type Thresholds } from './decide'
import { accuracyReport, enoughToMeasure, holdOutSplit, MIN_HELD_BACK, type AccuracyReport, type LabelledPrediction } from './accuracy'
import { loadLabelled, loadUndecided, SorterStore, type ProposalRow, type Shot } from './store'
import { applyCloud, decidedByLocal, settledAnswer } from './cloud/cascade'
import { answerScopes, voiceOfAnswer } from './cloud/provider'
import { EVERYTHING, inWindow, isSortPeriod, PERIOD_CHOICES, PERIOD_REFUSED, PERIOD_UNREADABLE, periodPhrase, periodWindow, storedPeriod, type PeriodWindow, type SortPeriod } from './period'

export const HOLD_OUT_FRACTION = 0.2

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
  /** A held-back report with enough items of each label exists, so sorting may run without him watching. */
  canRunUnattended: boolean
  /** A model exists but was trained under an older sorter version: sorting is refused until retrained. */
  retrainNeeded: boolean
  /** The least held-back evidence needed (shown in Settings when there is not enough yet). */
  minHeldBack: { total: number; perLabel: number }
  pending: { keep: number; throwaway: number; doubtful: number; lastProposedAt: string | null }
  /** The period a manual sort is limited to (one setting for both sort buttons); null when the stored one cannot be read. */
  period: SortPeriod | null
  /** The periods that can be chosen, in the order shown. */
  periods: ReadonlyArray<{ id: SortPeriod; label: string }>
}

export type SortResult = { ok: boolean; sorted?: number; counts?: { keep: number; throwaway: number; doubtful: number }; error?: string; /** The period this run was limited to, and it inside a sentence (' from the last 30 days'; '' for everything). */ period?: SortPeriod; periodPhrase?: string }

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
  now?: () => Date
}

/** A model counts only when it and its report were made under the current sorter version. */
function isCurrent(rec: { sorterVersion: string; report: { sorterVersion?: string } }): boolean {
  return rec.sorterVersion === SORTER_VERSION && rec.report?.sorterVersion === SORTER_VERSION
}

type Run = Pick<SorterStatus, 'phase' | 'done' | 'total' | 'message' | 'error'>

export class SorterService {
  private run: Run = { phase: 'idle', done: 0, total: 0, message: '', error: null }
  private abort: AbortController | null = null
  private lastPush = 0

  constructor(private deps: SorterDeps) {}

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

  status(): SorterStatus {
    const { rec, pending } = this.withStore((s) => ({ rec: s.latestModel<SorterReport>(), pending: s.pendingCounts() }))
    const current = rec ? isCurrent(rec) : false
    const report = current ? rec!.report : null
    return { ...this.run, modelReady: this.deps.pictures.modelReady(), report, canRunUnattended: current && enoughToMeasure(report?.heldBack), retrainNeeded: Boolean(rec) && !current, minHeldBack: MIN_HELD_BACK, pending, period: this.period(), periods: PERIOD_CHOICES }
  }

  /** The period chosen in Settings; null when what is stored is not a period. */
  period(): SortPeriod | null {
    return storedPeriod(this.deps.period ? this.deps.period() : undefined)
  }

  /** Push the status again (the period was changed). */
  notify(): void {
    this.deps.broadcast(this.status())
  }

  /**
   * "Sort undecided screenshots now": the period chosen in Settings, its cut-off taken from this
   * process's clock. Nothing is sorted when the stored period cannot be read.
   */
  async sortManual(opts: { limit?: number } = {}): Promise<SortResult> {
    const p = this.period()
    const window = p ? periodWindow(p, this.deps.now ? this.deps.now() : new Date()) : null
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

  /** Train on his history and report accuracy on a held-back 20%. Returns the report. */
  async trainAndTest(): Promise<{ ok: boolean; cancelled?: boolean; report?: SorterReport; error?: string }> {
    if (this.busy()) return { ok: false, error: 'the sorter is already running' }
    if (!this.deps.pictures.modelReady()) return { ok: false, error: 'download the picture search model first (Settings › Picture search)' }
    const ctl = new AbortController()
    this.abort = ctl
    try {
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
      for (const [ti, s] of test.entries()) {
        const rule = applyRules(s.facts)
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
        trainedOn: held.trainedOn,
        l2: held.l2,
        calibration: held.calibrationCheck ?? null,
        heldBackClassifier: { auc: auc(scored), brier: brier(scored), reliability: reliabilityTable(scored.map((x) => ({ pThrow: 1 - x.p, binned: !x.keep }))) },
        heldBack: accuracyReport(both),
        rulesOnly: accuracyReport(rulesAlone)
      }
      report.enoughToMeasure = enoughToMeasure(report.heldBack)
      if (ctl.signal.aborted) throw new Error('cancelled') // last check before anything is saved
      this.withStore((s) => s.saveModel({ id: `model-${trainedAt}`, trainedAt, sorterVersion: SORTER_VERSION, model: final, report }))
      this.set({ phase: 'idle', done: 0, total: 0, message: '', error: null }, true)
      return { ok: true, report }
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
   * only). Writes proposals only, and none for a screenshot outside the window.
   */
  async sortUndecided(opts: { limit?: number; window?: PeriodWindow } = {}): Promise<SortResult> {
    const window = opts.window ?? EVERYTHING
    if (!isSortPeriod(window.period)) return { ok: false, error: PERIOD_REFUSED }
    const within = { period: window.period, periodPhrase: periodPhrase(window.period) }
    if (this.busy()) return { ok: false, error: 'the sorter is already running' }
    const rec = this.withStore((s) => s.latestModel<SorterReport>())
    if (!rec) return { ok: false, error: 'train the sorter on your past choices first; it needs an accuracy report before it sorts' }
    if (!isCurrent(rec)) return { ok: false, error: 'retrain needed: the sorter changed since it was last trained' }
    if (!enoughToMeasure(rec.report.heldBack)) return { ok: false, error: 'not enough of your past choices to measure accuracy yet' }
    if (!this.deps.pictures.modelReady()) return { ok: false, error: 'download the picture search model first (Settings › Picture search)' }
    const ctl = new AbortController()
    this.abort = ctl
    const counts = { keep: 0, throwaway: 0, doubtful: 0 }
    let sorted = 0
    try {
      let shots = loadUndecided(this.deps.wellRoot()).filter((s) => inWindow(s.takenAt, window))
      if (opts.limit !== undefined) shots = shots.slice(0, Math.max(0, opts.limit))
      const t = this.thresholds()
      // pictures of everything he kept: a look-alike of one of them leans throwaway
      const keptShots = loadLabelled(this.deps.wellRoot()).filter((s) => s.truth === 'keep' && s.image)
      const keptVectors = [...(await this.vectorsFor(keptShots, 'reading pictures of what you kept', ctl.signal)).values()]
      // answers already given by either cloud provider under its current model and prompt
      const asked = this.withStore((st) => st.cloudAnswersIn(answerScopes()))
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
          const rule = applyRules(s.facts)
          const verdict = decide(rule, v ? predictKeep(rec.model, v) : null, t, v ? (tierOf.get(s) ?? null) : null)
          const local = { proposal: verdict.proposal, confidence: verdict.confidence, pKeep: verdict.pKeep, reason: verdict.reason, decidedBy: decidedByLocal(verdict, rule, t) }
          // more than one provider may have answered it: the answer that is a decision stands, else the one asked last
          const answer = verdict.proposal === 'doubtful' ? settledAnswer(asked.get(s.hash) ?? [], t) : null
          const who = answer ? voiceOfAnswer(answer.model, answer.promptVersion) : null
          const row = answer && who ? applyCloud(local, answer, who, t) : local
          rows.push({ hash: s.hash, ...row, rule: rule?.rule ?? null })
          counts[row.proposal]++
        }
        this.withStore((st) => st.writeProposals(rows, SORTER_VERSION, rec.id))
        sorted += rows.length
        this.set({ done: Math.min(shots.length, i + chunk.length) })
      }
      this.set({ phase: 'idle', done: 0, total: 0, message: '' }, true)
      return { ok: true, sorted, counts, ...within }
    } catch (e) {
      if (ctl.signal.aborted) {
        // Stop ended the worker mid-chunk: proposals already written stay, nothing more is recorded
        this.set({ phase: 'idle', done: 0, total: 0, message: '' }, true)
        return { ok: true, sorted, counts, ...within }
      }
      const msg = (e as Error)?.message ?? String(e)
      this.set({ phase: 'error', message: '', error: msg }, true)
      return { ok: false, sorted, counts, error: msg, ...within }
    } finally {
      this.abort = null
    }
  }
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
export function registerSorterIpc(svc: SorterService, allowed: (sender: Electron.WebContents) => boolean, setPeriod: (period: unknown) => { ok: boolean; period: SortPeriod | null; error?: string } = () => ({ ok: false, period: svc.period(), error: PERIOD_REFUSED })): void {
  const handle = (channel: string, fn: (...args: any[]) => unknown): void => { // eslint-disable-line @typescript-eslint/no-explicit-any
    ipcMain.handle(channel, (e, ...args) => {
      if (!allowed(e.sender)) throw new Error(`${channel}: not allowed from this window`)
      return fn(...args)
    })
  }
  handle('sorter:status', () => svc.status())
  handle('sorter:train', () => svc.trainAndTest())
  handle('sorter:sort', (opts?: { limit?: number }) => svc.sortManual({ limit: typeof opts?.limit === 'number' ? opts.limit : undefined }))
  handle('sorter:set-period', (period: unknown) => setPeriod(period))
  handle('sorter:cancel', () => svc.cancel())
}
