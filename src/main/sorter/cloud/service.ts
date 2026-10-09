/**
 * The sorter's cloud step as one main-process service: the nightly batch and the manual "Sort now".
 *
 *   Nightly (tick() finds a batch due, schedule.ts): run the local sorter (when it may run
 *     unattended), then ask Luna about the screenshots it left doubtful, at most `nightlyCap`.
 *   Sort now: prepare() runs the local sorter and returns how many screenshots would be sent and an
 *     estimated cost; nothing leaves the Mac until send(n) is called from his click.
 *
 * Only doubtful proposals that Luna has not already answered (for this model and prompt) are sent,
 * newest first, shrunk (images.ts), in chunks with at most LUNA.concurrency requests at a time.
 * Luna's answers go through the keep-bias in cascade.ts and are recorded per screenshot with
 * decided_by 'luna'. With no key, or offline, the cloud step is skipped and items stay doubtful.
 *
 * The key comes from ApiKeyStore (key-store.ts) at call time; nothing here stores, returns or logs it,
 * and every message that may reach a log or the renderer goes through redact().
 */
import { ipcMain } from 'electron'
import { loadUndecided, SorterStore, type CloudAnswerRow, type CloudPending } from '../store'
import { DEFAULT_THRESHOLDS, SORTER_VERSION, type Thresholds } from '../decide'
import { applyLuna, type CascadeRow } from './cascade'
import { buildLunaRequest, estimateCost, LUNA, LunaResponseError, parseLunaResponse, planChunks, selectForCloud, type CloudCandidate, type CostEstimate, type LunaItem } from './luna'
import { LunaHttpError, pool, postLuna, redact, type HttpPost } from './client'
import { DEFAULT_BATCH_TIME, isBatchDue, nextSlot, normaliseBatchTime } from './schedule'

export type CloudSettings = { enabled: boolean; batchTime: string; nightlyCap: number }
export const DEFAULT_NIGHTLY_CAP = 300
export const MAX_CAP = 5000

export function normaliseCloudSettings(raw: Partial<Record<keyof CloudSettings, unknown>> | undefined): CloudSettings {
  const r = raw ?? {}
  const cap = typeof r.nightlyCap === 'number' && Number.isFinite(r.nightlyCap) ? Math.min(MAX_CAP, Math.max(0, Math.floor(r.nightlyCap))) : DEFAULT_NIGHTLY_CAP
  return { enabled: r.enabled === undefined ? true : r.enabled === true, batchTime: normaliseBatchTime(r.batchTime ?? DEFAULT_BATCH_TIME), nightlyCap: cap }
}

export type CloudSkip = 'no-key' | 'offline' | 'nothing-doubtful' | 'key-rejected' | 'cancelled'

export type CloudRunSummary = {
  at: string
  trigger: 'nightly' | 'manual'
  /** The local step of this run (null when a manual send only ran the cloud step). */
  local: { ok: boolean; message: string } | null
  asked: number
  answered: number
  keep: number
  throwaway: number
  stayedDoubtful: number
  skipped: CloudSkip | null
  error: string | null
  message: string
}

export type CloudPreview = {
  local: { ok: boolean; message: string }
  /** Doubtful screenshots Luna has not answered yet. */
  doubtful: number
  /** How many a send would ask about (doubtful, capped). */
  toSend: number
  cap: number
  estimate: CostEstimate
  /** Why nothing can be sent now; null when send() may go ahead. */
  blocked: 'no-key' | 'offline' | 'busy' | 'nothing-doubtful' | null
  message: string
}

export type CloudStatus = {
  phase: 'idle' | 'sorting' | 'asking'
  done: number
  total: number
  hasKey: boolean
  encryptionAvailable: boolean
  settings: CloudSettings
  lastRun: CloudRunSummary | null
  nextRunAt: string | null
  model: string
  longEdge: number
}

export type CloudState = { lastRunAt: string | null; since: string | null; lastRun: CloudRunSummary | null }

export type CloudDeps = {
  wellRoot: () => string
  /** The local sorter (sorter/service.ts sortUndecided). */
  sortLocal: () => Promise<{ ok: boolean; sorted?: number; error?: string }>
  /** The local sorter has a current model with enough held-back evidence to run unattended. */
  canSortLocal: () => boolean
  key: { get(): string | null; has(): boolean; encryptionAvailable(): boolean }
  online: () => boolean
  http: HttpPost
  shrink: (path: string) => Promise<{ mime: string; base64: string }>
  settings: () => CloudSettings
  state: () => CloudState
  saveState: (patch: Partial<CloudState>) => void
  broadcast: (s: CloudStatus) => void
  log?: (line: string) => void
  thresholds?: Thresholds
  now?: () => Date
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  endpoint?: string
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`

export class CloudSorter {
  private phase: CloudStatus['phase'] = 'idle'
  private done = 0
  private total = 0
  private abort: AbortController | null = null

  constructor(private deps: CloudDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date()
  }

  private log(line: string): void {
    this.deps.log?.(`[sorter-cloud] ${redact(line, this.safeKey())}`)
  }

  private safeKey(): string | null {
    try {
      return this.deps.key.get()
    } catch {
      return null
    }
  }

  private withStore<T>(fn: (s: SorterStore) => T): T {
    const s = new SorterStore(this.deps.wellRoot())
    try {
      return fn(s)
    } finally {
      s.close()
    }
  }

  status(): CloudStatus {
    const settings = this.deps.settings()
    return {
      phase: this.phase,
      done: this.done,
      total: this.total,
      hasKey: this.deps.key.has(),
      encryptionAvailable: this.deps.key.encryptionAvailable(),
      settings,
      lastRun: this.deps.state().lastRun,
      nextRunAt: settings.enabled ? nextSlot(this.now(), settings.batchTime).toISOString() : null,
      model: LUNA.model,
      longEdge: LUNA.longEdge
    }
  }

  private push(): void {
    this.deps.broadcast(this.status())
  }

  busy(): boolean {
    return this.phase !== 'idle'
  }

  cancel(): void {
    this.abort?.abort()
  }

  /** Doubtful screenshots Luna has not answered, with a readable picture on this Mac. */
  private candidates(): { list: CloudCandidate[]; pending: Map<string, CloudPending> } {
    const pendingRows = this.withStore((s) => s.cloudPending(SORTER_VERSION, LUNA.model, LUNA.promptVersion))
    const pending = new Map(pendingRows.map((p) => [p.hash, p]))
    if (!pending.size) return { list: [], pending }
    const list: CloudCandidate[] = []
    for (const s of loadUndecided(this.deps.wellRoot())) {
      if (!s.hash || !s.image || !pending.has(s.hash)) continue
      list.push({ hash: s.hash, proposal: 'doubtful', path: s.image.path, app: s.facts.app ?? '', windowTitle: s.facts.windowTitle ?? '', takenAt: s.takenAt ?? '' })
    }
    return { list, pending }
  }

  private async runLocal(): Promise<{ ok: boolean; message: string }> {
    if (!this.deps.canSortLocal()) return { ok: false, message: 'The sorter on this Mac is not trained enough to sort on its own yet; only screenshots it already found doubtful can be asked about.' }
    this.phase = 'sorting'
    this.push()
    try {
      const r = await this.deps.sortLocal()
      return r.ok ? { ok: true, message: `Sorted ${plural(r.sorted ?? 0, 'screenshot')} on this Mac.` } : { ok: false, message: r.error ?? 'The sorter on this Mac stopped.' }
    } catch (e) {
      return { ok: false, message: (e as Error)?.message ?? 'The sorter on this Mac stopped.' }
    }
  }

  /** Sort now, step 1: the local sorter, then what a send would cost. Sends nothing. */
  async prepare(): Promise<CloudPreview> {
    const cap = this.deps.settings().nightlyCap
    if (this.busy()) return { local: { ok: false, message: '' }, doubtful: 0, toSend: 0, cap, estimate: estimateCost(0), blocked: 'busy', message: 'The sorter is already running.' }
    let local: { ok: boolean; message: string }
    try {
      local = await this.runLocal()
    } finally {
      this.phase = 'idle'
      this.push()
    }
    const { list } = this.candidates()
    const toSend = Math.min(list.length, cap)
    const blocked: CloudPreview['blocked'] = !list.length ? 'nothing-doubtful' : !this.deps.key.has() ? 'no-key' : !this.deps.online() ? 'offline' : null
    const message =
      blocked === 'nothing-doubtful'
        ? 'Nothing doubtful is waiting for Luna.'
        : blocked === 'no-key'
          ? `${plural(list.length, 'screenshot')} stay in Review: no OpenAI key is saved.`
          : blocked === 'offline'
            ? `${plural(list.length, 'screenshot')} stay in Review: this Mac is offline.`
            : `Ask Luna about ${plural(toSend, 'screenshot')}${toSend < list.length ? ` of ${list.length.toLocaleString('en-GB')} (the limit per run)` : ''}?`
    return { local, doubtful: list.length, toSend, cap, estimate: estimateCost(toSend), blocked, message }
  }

  /** Sort now, step 2 (after his click): ask Luna about at most `max` doubtful screenshots. */
  async send(max: number): Promise<CloudRunSummary> {
    const n = typeof max === 'number' && Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0
    const summary = await this.runCloud(Math.min(n, this.deps.settings().nightlyCap), 'manual', null)
    this.deps.saveState({ lastRun: summary })
    this.push()
    return summary
  }

  /** The nightly batch: local sorter, then Luna for what it left doubtful (capped). */
  async runNightly(): Promise<CloudRunSummary> {
    this.deps.saveState({ lastRunAt: this.now().toISOString() }) // first, so a crash mid-run is not retried every minute
    let local: { ok: boolean; message: string }
    try {
      local = await this.runLocal()
    } finally {
      this.phase = 'idle'
    }
    const summary = await this.runCloud(this.deps.settings().nightlyCap, 'nightly', local)
    this.deps.saveState({ lastRun: summary })
    this.push()
    return summary
  }

  /** Called at launch and every minute: start the nightly batch when one is due. */
  async tick(): Promise<CloudRunSummary | null> {
    const st = this.deps.state()
    if (!st.since) {
      this.deps.saveState({ since: this.now().toISOString() })
      return null
    }
    const s = this.deps.settings()
    if (this.busy() || !isBatchDue({ now: this.now(), enabled: s.enabled, batchTime: s.batchTime, lastRunAt: st.lastRunAt, since: st.since })) return null
    this.log('nightly batch due')
    return this.runNightly()
  }

  private async runCloud(limit: number, trigger: CloudRunSummary['trigger'], local: CloudRunSummary['local']): Promise<CloudRunSummary> {
    const at = this.now().toISOString()
    const base: CloudRunSummary = { at, trigger, local, asked: 0, answered: 0, keep: 0, throwaway: 0, stayedDoubtful: 0, skipped: null, error: null, message: '' }
    const finish = (patch: Partial<CloudRunSummary>): CloudRunSummary => {
      const s = { ...base, ...patch }
      s.message = describe(s)
      this.log(`${trigger} run: asked ${s.asked}, answered ${s.answered} (keep ${s.keep}, throwaway ${s.throwaway}, still doubtful ${s.stayedDoubtful})${s.skipped ? `, skipped: ${s.skipped}` : ''}${s.error ? `, error: ${s.error}` : ''}`)
      return s
    }
    if (this.busy()) return finish({ error: 'The sorter is already running.' })
    const { list, pending } = this.candidates()
    if (!list.length) return finish({ skipped: 'nothing-doubtful' })
    const key = this.deps.key.get()
    if (!key) return finish({ skipped: 'no-key', stayedDoubtful: list.length })
    if (!this.deps.online()) return finish({ skipped: 'offline', stayedDoubtful: list.length })
    const selected = selectForCloud(list, limit)
    if (!selected.length) return finish({ skipped: 'nothing-doubtful', stayedDoubtful: list.length })

    const t = this.deps.thresholds ?? DEFAULT_THRESHOLDS
    const ctl = new AbortController()
    this.abort = ctl
    this.phase = 'asking'
    this.done = 0
    this.total = selected.length
    this.push()
    let fatal: LunaHttpError | null = null
    let chunkError: string | null = null
    const counts = { asked: 0, answered: 0, keep: 0, throwaway: 0 }
    try {
      await pool(
        planChunks(selected, LUNA.chunkSize),
        LUNA.concurrency,
        async (chunk) => {
          const items: LunaItem[] = []
          for (const c of chunk) {
            if (ctl.signal.aborted) return
            try {
              items.push({ hash: c.hash, proposal: c.proposal, app: c.app, windowTitle: c.windowTitle, image: await this.deps.shrink(c.path) })
            } catch {
              /* unreadable picture: it stays doubtful */
            }
          }
          if (!items.length || ctl.signal.aborted) return
          const req = buildLunaRequest(items)
          counts.asked += req.ids.size
          try {
            const json = await postLuna(req.body, {
              key,
              http: this.deps.http,
              endpoint: this.deps.endpoint,
              signal: ctl.signal,
              sleep: this.deps.sleep,
              onRetry: (attempt, why, wait) => this.log(`retry ${attempt} after ${why}, waiting ${wait} ms`)
            })
            const parsed = parseLunaResponse(json, req.ids)
            const askedAt = new Date().toISOString()
            const answers: CloudAnswerRow[] = []
            const proposals: Array<CascadeRow & { hash: string }> = []
            for (const [hash, a] of parsed.answers) {
              answers.push({ hash, ...a, model: LUNA.model, promptVersion: LUNA.promptVersion, askedAt })
              const p = pending.get(hash)
              if (!p) continue
              const row = applyLuna({ proposal: 'doubtful', confidence: p.confidence, pKeep: p.pKeep, reason: p.reason, decidedBy: null }, a, t)
              proposals.push({ hash, ...row })
              counts.answered++
              if (row.proposal === 'keep') counts.keep++
              else if (row.proposal === 'throwaway') counts.throwaway++
            }
            this.withStore((s) => s.saveCloudResults(answers, proposals))
            if (parsed.missing.length) this.log(`${parsed.missing.length} screenshot(s) in a request got no usable answer; they stay doubtful`)
          } catch (e) {
            if (e instanceof LunaHttpError && (e.kind === 'offline' || e.kind === 'auth' || e.kind === 'rate' || e.kind === 'cancelled')) {
              fatal ??= e
              ctl.abort()
            } else {
              chunkError = redact(e instanceof LunaHttpError || e instanceof LunaResponseError ? e.message : 'Luna’s answer could not be read', key)
              this.log(`a request failed: ${chunkError}`)
            }
          } finally {
            this.done = Math.min(this.total, this.done + chunk.length)
            this.push()
          }
        },
        () => ctl.signal.aborted
      )
    } finally {
      this.abort = null
      this.phase = 'idle'
      this.done = 0
      this.total = 0
    }
    const stayedDoubtful = list.length - counts.keep - counts.throwaway
    const f = fatal as LunaHttpError | null
    if (f) {
      const skipped: CloudSkip | null = f.kind === 'offline' ? 'offline' : f.kind === 'auth' ? 'key-rejected' : f.kind === 'cancelled' ? 'cancelled' : null
      return finish({ ...counts, stayedDoubtful, skipped, error: skipped === 'offline' || skipped === 'cancelled' ? null : redact(f.message, key) })
    }
    return finish({ ...counts, stayedDoubtful, error: chunkError })
  }
}

/** One plain sentence for Settings. */
export function describe(s: CloudRunSummary): string {
  const waiting = s.stayedDoubtful ? ` ${plural(s.stayedDoubtful, 'screenshot')} still need${s.stayedDoubtful === 1 ? 's' : ''} a look.` : ''
  switch (s.skipped) {
    case 'nothing-doubtful':
      return 'Nothing doubtful was waiting for Luna.'
    case 'no-key':
      return `Luna was not asked: no OpenAI key is saved.${waiting}`
    case 'offline':
      return `Luna was not asked${s.answered ? ' about all of them' : ''}: this Mac was offline.${waiting}`
    case 'key-rejected':
      return `OpenAI did not accept the API key.${waiting}`
    case 'cancelled':
      return `Stopped.${waiting}`
  }
  if (s.error && !s.answered) return `Luna could not answer: ${s.error}.${waiting}`
  return `Asked Luna about ${plural(s.asked, 'screenshot')}: ${s.keep.toLocaleString('en-GB')} keep, ${s.throwaway.toLocaleString('en-GB')} throwaway.${waiting}`
}

/** IPC for Settings › Screenshot sorter › Luna. Types: src/preload/index.ts. Never returns the key. */
export function registerCloudIpc(
  svc: CloudSorter,
  key: { set(k: unknown): { ok: boolean; saved: boolean; error?: string }; clear(): void },
  saveSettings: (s: CloudSettings) => void,
  current: () => CloudSettings,
  allowed: (sender: Electron.WebContents) => boolean
): void {
  const handle = (channel: string, fn: (...args: any[]) => unknown): void => { // eslint-disable-line @typescript-eslint/no-explicit-any
    ipcMain.handle(channel, (e, ...args) => {
      if (!allowed(e.sender)) throw new Error(`${channel}: not allowed from this window`)
      return fn(...args)
    })
  }
  handle('cloud:status', () => svc.status())
  handle('cloud:set-key', (k: unknown) => {
    const r = key.set(k)
    return { ok: r.ok, saved: r.saved, error: r.error, status: svc.status() }
  })
  handle('cloud:clear-key', () => {
    key.clear()
    return svc.status()
  })
  handle('cloud:set-settings', (patch: unknown) => {
    const p = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {}
    saveSettings(normaliseCloudSettings({ ...current(), ...p }))
    return svc.status()
  })
  handle('cloud:prepare', () => svc.prepare())
  handle('cloud:send', (n: unknown) => svc.send(typeof n === 'number' ? n : 0))
  handle('cloud:cancel', () => svc.cancel())
}
