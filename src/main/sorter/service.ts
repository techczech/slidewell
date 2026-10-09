/**
 * The screenshot sorter, local part, as one main-process service.
 *
 *   trainAndTest(): embed his labelled history (picture-search engine), hold back 20% of it, train
 *     the classifier on the rest, write the accuracy report on the held-back sample, then train the
 *     model it will use on all of it. Saves model + report (store.ts).
 *   sortUndecided(): for every undecided screenshot in triage: rules + classifier → a proposal with
 *     confidence and reason, recorded in sorter_proposals. Needs a trained model with a report.
 *
 * Sorting writes proposals only: it never moves, deletes or decides anything (binning is later
 * work), and it never writes his triage decisions. Nothing here makes a network call.
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
    return { ...this.run, modelReady: this.deps.pictures.modelReady(), report, canRunUnattended: current && enoughToMeasure(report?.heldBack), retrainNeeded: Boolean(rec) && !current, minHeldBack: MIN_HELD_BACK, pending }
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
      for (const s of test) {
        const rule = applyRules(s.facts)
        const p = predictKeep(held, vectors.get(s.image!.id)!)
        scored.push({ p, keep: s.truth === 'keep' })
        both.push({ truth: s.truth!, proposal: decide(rule, p, t).proposal })
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

  /** Propose keep / throwaway / doubtful for every undecided screenshot. Writes proposals only. */
  async sortUndecided(opts: { limit?: number } = {}): Promise<{ ok: boolean; sorted?: number; counts?: { keep: number; throwaway: number; doubtful: number }; error?: string }> {
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
      let shots = loadUndecided(this.deps.wellRoot())
      if (opts.limit !== undefined) shots = shots.slice(0, Math.max(0, opts.limit))
      const t = this.thresholds()
      this.set({ phase: 'sorting', done: 0, total: shots.length, message: 'sorting undecided screenshots', error: null }, true)
      const CHUNK = 25
      for (let i = 0; i < shots.length && !ctl.signal.aborted; i += CHUNK) {
        const chunk = shots.slice(i, i + CHUNK)
        const items = chunk.flatMap((s) => (s.image ? [s.image] : []))
        const vectors = await this.deps.pictures.ensureVectors(items, { signal: ctl.signal })
        const rows: ProposalRow[] = []
        for (const s of chunk) {
          if (!s.hash) continue
          const v = s.image ? vectors.get(s.image.id) : undefined
          if (s.image && !v && ctl.signal.aborted) continue // not reached before cancel: no proposal
          const rule = applyRules(s.facts)
          const verdict = decide(rule, v ? predictKeep(rec.model, v) : null, t)
          rows.push({ hash: s.hash, proposal: verdict.proposal, confidence: verdict.confidence, pKeep: verdict.pKeep, reason: verdict.reason, rule: rule?.rule ?? null })
          counts[verdict.proposal]++
        }
        this.withStore((st) => st.writeProposals(rows, SORTER_VERSION, rec.id))
        sorted += rows.length
        this.set({ done: Math.min(shots.length, i + chunk.length) })
      }
      this.set({ phase: 'idle', done: 0, total: 0, message: '' }, true)
      return { ok: true, sorted, counts }
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      this.set({ phase: 'error', message: '', error: msg }, true)
      return { ok: false, sorted, counts, error: msg }
    } finally {
      this.abort = null
    }
  }
}

/** IPC for Settings › Screenshot sorter. Types: src/preload/index.ts. */
export function registerSorterIpc(svc: SorterService, allowed: (sender: Electron.WebContents) => boolean): void {
  const handle = (channel: string, fn: (...args: any[]) => unknown): void => { // eslint-disable-line @typescript-eslint/no-explicit-any
    ipcMain.handle(channel, (e, ...args) => {
      if (!allowed(e.sender)) throw new Error(`${channel}: not allowed from this window`)
      return fn(...args)
    })
  }
  handle('sorter:status', () => svc.status())
  handle('sorter:train', () => svc.trainAndTest())
  handle('sorter:sort', (opts?: { limit?: number }) => svc.sortUndecided({ limit: typeof opts?.limit === 'number' ? opts.limit : undefined }))
  handle('sorter:cancel', () => svc.cancel())
}
