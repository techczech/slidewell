/**
 * The sorter's cloud step as one main-process service: the nightly batch and the manual "Sort now".
 *
 * Consent lives here, not in the renderer:
 *   - The cloud step is off until he turns it on in Settings; main records the moment (optedInAt in
 *     config.json). Saving a key does not turn it on. Off means no nightly upload and no Sort now upload.
 *   - Sort now: prepare() runs the local sorter, picks the batch and returns its count, cost and a
 *     one-time token; send(token) sends exactly that batch (less anything no longer eligible), and
 *     refuses without the token of the batch prepared last, or once it is PREPARED_TTL_MS old.
 *   - At most NIGHTLY_LIMIT screenshots go to Luna per night window (schedule.ts nightOf), nightly
 *     and Sort now together. The count is kept in triage.db and checked when a run claims its batch
 *     (store.ts claimForCloud), so moving the batch time or pressing Sort now cannot exceed it.
 *
 * What is sent: doubtful screenshots (screenshot file names only, luna.ts isScreenshotFile) Luna has
 * not answered for this model and prompt, newest first. A run claims them in one transaction, so two
 * processes never send the same one. Just before each request, each one is re-read and must still hash
 * to the hash it was classified under (a regular file, not a link; images.ts readVerified), and must
 * still be eligible (no decision of his, not answered in review); otherwise it is not sent.
 * Luna's answers are redacted (no key) before they are stored or shown, then go through the keep-bias
 * in cascade.ts and are recorded with decided_by 'luna'. No key, or offline: skipped, items stay doubtful.
 *
 * The key comes from ApiKeyStore (key-store.ts) at call time; nothing here stores, returns or logs it,
 * and every message that may reach a log, the database or the renderer goes through redact().
 */
import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { loadUndecided, SorterStore, type CloudAnswerRow, type CloudPending, type CloudScope } from '../store'
import { DEFAULT_THRESHOLDS, SORTER_VERSION, type Thresholds } from '../decide'
import { applyLuna, type CascadeRow } from './cascade'
import { buildLunaRequest, estimateCost, LUNA, LunaResponseError, parseLunaResponse, planChunks, selectForCloud, type CloudCandidate, type CostEstimate, type LunaItem } from './luna'
import { LunaHttpError, pool, postLuna, redact, type HttpPost } from './client'
import { readVerified, type VerifyRefusal } from './images'
import { DEFAULT_BATCH_TIME, isBatchDue, nextSlot, nightOf, normaliseBatchTime } from './schedule'

/** Screenshots sent to Luna per night window, nightly and Sort now together. Fixed; not a setting. */
export const NIGHTLY_LIMIT = 300
/** How long a prepared Sort now batch can be sent. */
export const PREPARED_TTL_MS = 10 * 60 * 1000

/** The settings as the service reads them. `enabled` is true only after his recorded opt-in. */
export type CloudSettings = { enabled: boolean; batchTime: string }
/** What config.json stores for them. */
export type StoredCloudSettings = { optedInAt?: string | null; batchTime?: string }

export function normaliseCloudSettings(raw: StoredCloudSettings | Record<string, unknown> | undefined): CloudSettings {
  const r = (raw ?? {}) as Record<string, unknown>
  const opted = typeof r.optedInAt === 'string' && Number.isFinite(Date.parse(r.optedInAt))
  return { enabled: opted, batchTime: normaliseBatchTime(r.batchTime ?? DEFAULT_BATCH_TIME) }
}

/**
 * A settings change from the renderer, as what to store: `enabled: true` records the opt-in now
 * (kept if already on), `enabled: false` clears it; `batchTime` is normalised. Nothing else is read.
 */
export function applySettingsPatch(cur: StoredCloudSettings, patch: unknown, now: Date): StoredCloudSettings {
  const p = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {}
  const out: StoredCloudSettings = { optedInAt: normaliseCloudSettings(cur).enabled ? (cur.optedInAt ?? null) : null, batchTime: normaliseBatchTime(cur.batchTime ?? DEFAULT_BATCH_TIME) }
  if (p.enabled === true && !out.optedInAt) out.optedInAt = now.toISOString()
  if (p.enabled === false) out.optedInAt = null
  if (p.batchTime !== undefined) out.batchTime = normaliseBatchTime(p.batchTime)
  return out
}

export type CloudSkip = 'off' | 'no-key' | 'offline' | 'nothing-doubtful' | 'key-rejected' | 'cancelled' | 'limit-reached' | 'not-prepared'

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
  /** How many a send would ask about (doubtful, within what is left tonight). */
  toSend: number
  /** The per-night limit. */
  cap: number
  /** What is left of tonight's limit. */
  leftTonight: number
  estimate: CostEstimate
  /** Why nothing can be sent now; null when send(token) may go ahead. */
  blocked: 'off' | 'no-key' | 'offline' | 'busy' | 'nothing-doubtful' | 'limit-reached' | null
  /** One-time token for send(); null when blocked. */
  token: string | null
  message: string
}

export type CloudStatus = {
  phase: 'idle' | 'sorting' | 'asking'
  done: number
  total: number
  hasKey: boolean
  encryptionAvailable: boolean
  settings: CloudSettings
  nightlyLimit: number
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
  /** Shrink verified bytes for sending (images.ts shrinkForLuna). */
  shrink: (bytes: Buffer) => Promise<{ mime: string; base64: string }>
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
const SCOPE: CloudScope = { sorterVersion: SORTER_VERSION, model: LUNA.model, promptVersion: LUNA.promptVersion }

export class CloudSorter {
  private phase: CloudStatus['phase'] = 'idle'
  private done = 0
  private total = 0
  private abort: AbortController | null = null
  private prepared: { token: string; hashes: string[]; expiresAt: number } | null = null

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
      nightlyLimit: NIGHTLY_LIMIT,
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
    const pendingRows = this.withStore((s) => s.cloudPending(SCOPE.sorterVersion, SCOPE.model, SCOPE.promptVersion))
    const pending = new Map(pendingRows.map((p) => [p.hash, p]))
    if (!pending.size) return { list: [], pending }
    const list: CloudCandidate[] = []
    for (const s of loadUndecided(this.deps.wellRoot())) {
      if (!s.hash || !s.image || !pending.has(s.hash)) continue
      list.push({ hash: s.hash, proposal: 'doubtful', path: s.image.path, filename: s.facts.filename ?? '', app: s.facts.app ?? '', windowTitle: s.facts.windowTitle ?? '', takenAt: s.takenAt ?? '' })
    }
    // screenshots only (by file name); anything else never counts as waiting for Luna
    return { list: selectForCloud(list, Number.MAX_SAFE_INTEGER), pending }
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

  /** Sort now, step 1: the local sorter, then the batch a send would ask about and its cost. Sends nothing. */
  async prepare(): Promise<CloudPreview> {
    this.prepared = null
    const none = (patch: Partial<CloudPreview>): CloudPreview => ({ local: { ok: false, message: '' }, doubtful: 0, toSend: 0, cap: NIGHTLY_LIMIT, leftTonight: 0, estimate: estimateCost(0), blocked: null, token: null, message: '', ...patch })
    if (this.busy()) return none({ blocked: 'busy', message: 'The sorter is already running.' })
    let local: { ok: boolean; message: string }
    try {
      local = await this.runLocal()
    } finally {
      this.phase = 'idle'
      this.push()
    }
    const { list } = this.candidates()
    const leftTonight = Math.max(0, NIGHTLY_LIMIT - this.withStore((s) => s.allowanceUsed(nightOf(this.now()))))
    const batch = selectForCloud(list, leftTonight)
    const toSend = batch.length
    const blocked: CloudPreview['blocked'] = !list.length
      ? 'nothing-doubtful'
      : !this.deps.settings().enabled
        ? 'off'
        : !this.deps.key.has()
          ? 'no-key'
          : !this.deps.online()
            ? 'offline'
            : !toSend
              ? 'limit-reached'
              : null
    const waiting = plural(list.length, 'screenshot')
    const message =
      blocked === 'nothing-doubtful'
        ? 'Nothing doubtful is waiting for Luna.'
        : blocked === 'off'
          ? `${waiting} stay in Review: asking Luna is turned off.`
          : blocked === 'no-key'
            ? `${waiting} stay in Review: no OpenAI key is saved.`
            : blocked === 'offline'
              ? `${waiting} stay in Review: this Mac is offline.`
              : blocked === 'limit-reached'
                ? `${waiting} stay in Review: Luna has had ${NIGHTLY_LIMIT.toLocaleString('en-GB')} screenshots tonight, the most per night.`
                : `Ask Luna about ${plural(toSend, 'screenshot')}${toSend < list.length ? ` of ${list.length.toLocaleString('en-GB')} (${leftTonight.toLocaleString('en-GB')} left of tonight’s ${NIGHTLY_LIMIT.toLocaleString('en-GB')})` : ''}?`
    let token: string | null = null
    if (!blocked) {
      token = randomUUID()
      this.prepared = { token, hashes: batch.map((c) => c.hash), expiresAt: this.now().getTime() + PREPARED_TTL_MS }
    }
    return { local, doubtful: list.length, toSend, cap: NIGHTLY_LIMIT, leftTonight, estimate: estimateCost(toSend), blocked, token, message }
  }

  /**
   * Sort now, step 2 (after his click): send the batch prepare() showed him. Refused without the
   * token of the batch prepared last, or once it is PREPARED_TTL_MS old; a token is used once.
   */
  async send(token: unknown): Promise<CloudRunSummary> {
    const p = this.prepared
    let summary: CloudRunSummary
    if (!p || typeof token !== 'string' || token !== p.token) {
      summary = this.refused('manual', 'This send was not prepared here. Press Sort now and confirm the count first.')
    } else {
      this.prepared = null
      summary =
        this.now().getTime() > p.expiresAt
          ? this.refused('manual', 'The prepared batch is too old. Press Sort now again to see the current count.')
          : await this.runCloud({ trigger: 'manual', local: null, only: p.hashes })
    }
    this.deps.saveState({ lastRun: summary })
    this.push()
    return summary
  }

  private refused(trigger: CloudRunSummary['trigger'], error: string): CloudRunSummary {
    this.log(`${trigger} send refused: not prepared`)
    const s: CloudRunSummary = { at: this.now().toISOString(), trigger, local: null, asked: 0, answered: 0, keep: 0, throwaway: 0, stayedDoubtful: 0, skipped: 'not-prepared', error, message: '' }
    s.message = describe(s)
    return s
  }

  /** The nightly batch: local sorter, then Luna for what it left doubtful (within tonight's limit). */
  async runNightly(): Promise<CloudRunSummary> {
    this.deps.saveState({ lastRunAt: this.now().toISOString() }) // first, so a crash mid-run is not retried every minute
    let local: { ok: boolean; message: string }
    try {
      local = await this.runLocal()
    } finally {
      this.phase = 'idle'
    }
    const summary = await this.runCloud({ trigger: 'nightly', local })
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

  private async runCloud(o: { trigger: CloudRunSummary['trigger']; local: CloudRunSummary['local']; only?: string[] }): Promise<CloudRunSummary> {
    const { trigger, local } = o
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
    let pool0 = list
    if (o.only) {
      const byHash = new Map(list.map((c) => [c.hash, c]))
      pool0 = o.only.map((h) => byHash.get(h)).filter((c): c is CloudCandidate => Boolean(c))
    }
    if (!pool0.length) return finish({ skipped: 'nothing-doubtful', stayedDoubtful: list.length })
    if (!this.deps.settings().enabled) return finish({ skipped: 'off', stayedDoubtful: list.length })
    const key = this.deps.key.get()
    if (!key) return finish({ skipped: 'no-key', stayedDoubtful: list.length })
    if (!this.deps.online()) return finish({ skipped: 'offline', stayedDoubtful: list.length })
    const wanted = selectForCloud(pool0, NIGHTLY_LIMIT)
    if (!wanted.length) return finish({ skipped: 'nothing-doubtful', stayedDoubtful: list.length })

    // claim the batch in one transaction: tonight's limit and other runs (other processes too) are checked there
    const night = nightOf(this.now())
    const runId = randomUUID()
    const { claimed, leftBefore } = this.withStore((s) => s.claimForCloud(wanted.map((c) => c.hash), { ...SCOPE, night, limit: NIGHTLY_LIMIT, runId, now: this.now() }))
    if (!claimed.length) return finish({ skipped: leftBefore === 0 ? 'limit-reached' : 'nothing-doubtful', stayedDoubtful: list.length })
    const claimedSet = new Set(claimed)
    const selected = wanted.filter((c) => claimedSet.has(c.hash))

    const t = this.deps.thresholds ?? DEFAULT_THRESHOLDS
    const ctl = new AbortController()
    this.abort = ctl
    this.phase = 'asking'
    this.done = 0
    this.total = selected.length
    this.push()
    let fatal: LunaHttpError | null = null
    let chunkError: string | null = null
    let sent = 0
    const refused = new Map<VerifyRefusal | 'no-longer-eligible', number>()
    const refuse = (why: VerifyRefusal | 'no-longer-eligible', n = 1): void => void refused.set(why, (refused.get(why) ?? 0) + n)
    const counts = { asked: 0, answered: 0, keep: 0, throwaway: 0 }
    try {
      await pool(
        planChunks(selected, LUNA.chunkSize),
        LUNA.concurrency,
        async (chunk) => {
          const items: LunaItem[] = []
          for (const c of chunk) {
            if (ctl.signal.aborted) return
            // the bytes read are the bytes sent: same file, same hash it was classified under, not a link
            const v = await readVerified(c.path, c.hash)
            if (!v.ok) {
              refuse(v.why)
              continue
            }
            try {
              items.push({ hash: c.hash, proposal: c.proposal, app: c.app, windowTitle: c.windowTitle, image: await this.deps.shrink(v.bytes) })
            } catch {
              refuse('unreadable')
            }
          }
          if (!items.length || ctl.signal.aborted) return
          // eligibility again, just before the request: he may have decided or answered one meanwhile
          const live = this.withStore((s) => s.stillEligible(items.map((i) => i.hash), runId, SCOPE))
          const sendable = items.filter((i) => live.has(i.hash))
          if (sendable.length < items.length) refuse('no-longer-eligible', items.length - sendable.length)
          if (!sendable.length) return
          const req = buildLunaRequest(sendable)
          counts.asked += req.ids.size
          sent += req.ids.size
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
            for (const [hash, raw] of parsed.answers) {
              // whatever the model wrote, the key never reaches the database or the renderer
              const a = { ...raw, reason: redact(raw.reason, key) }
              answers.push({ hash, ...a, model: LUNA.model, promptVersion: LUNA.promptVersion, askedAt })
              const p = pending.get(hash)
              if (!p) continue
              const row = applyLuna({ proposal: 'doubtful', confidence: p.confidence, pKeep: p.pKeep, reason: p.reason, decidedBy: null }, a, t)
              proposals.push({ hash, ...row })
            }
            // the proposal write re-checks eligibility in SQL (store.ts saveCloudResults)
            const written = new Set(this.withStore((s) => s.saveCloudResults(answers, proposals)))
            for (const pr of proposals) {
              if (!written.has(pr.hash)) continue
              counts.answered++
              if (pr.proposal === 'keep') counts.keep++
              else if (pr.proposal === 'throwaway') counts.throwaway++
            }
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
      // claims go; screenshots that never went into a request are given back to tonight's limit
      this.withStore((s) => s.releaseClaims(runId, night, selected.length - sent))
    }
    for (const [why, n] of refused) this.log(`${n} screenshot(s) not sent: ${REFUSAL_WORDS[why]}`)
    const stayedDoubtful = list.length - counts.keep - counts.throwaway
    const f = fatal as LunaHttpError | null
    if (f) {
      const skipped: CloudSkip | null = f.kind === 'offline' ? 'offline' : f.kind === 'auth' ? 'key-rejected' : f.kind === 'cancelled' ? 'cancelled' : null
      return finish({ ...counts, stayedDoubtful, skipped, error: skipped === 'offline' || skipped === 'cancelled' ? null : redact(f.message, key) })
    }
    return finish({ ...counts, stayedDoubtful, error: chunkError })
  }
}

/** Log words for a screenshot that was not sent (never its path or name). */
const REFUSAL_WORDS: Record<VerifyRefusal | 'no-longer-eligible', string> = {
  changed: 'the file changed since it was scanned',
  symlink: 'the path is a link, not the file',
  'not-a-file': 'the path is not a regular file',
  'too-large': 'the file is too large',
  unreadable: 'the file could not be read',
  'no-longer-eligible': 'decided or answered meanwhile'
}

/** One plain sentence for Settings. */
export function describe(s: CloudRunSummary): string {
  const waiting = s.stayedDoubtful ? ` ${plural(s.stayedDoubtful, 'screenshot')} still need${s.stayedDoubtful === 1 ? 's' : ''} a look.` : ''
  switch (s.skipped) {
    case 'not-prepared':
      return `Nothing was sent. ${s.error ?? ''}`.trim()
    case 'off':
      return `Luna was not asked: asking Luna is turned off.${waiting}`
    case 'limit-reached':
      return `Luna was not asked: it has had ${NIGHTLY_LIMIT.toLocaleString('en-GB')} screenshots tonight, the most per night.${waiting}`
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
  saveSettings: (s: StoredCloudSettings) => void,
  current: () => StoredCloudSettings,
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
    const r = key.set(k) // saving a key never turns the cloud step on
    return { ok: r.ok, saved: r.saved, error: r.error, status: svc.status() }
  })
  handle('cloud:clear-key', () => {
    key.clear()
    return svc.status()
  })
  // only on/off (his opt-in, recorded here with its time) and the batch time can be set; the limit is fixed
  handle('cloud:set-settings', (patch: unknown) => {
    saveSettings(applySettingsPatch(current(), patch, new Date()))
    return svc.status()
  })
  handle('cloud:prepare', () => svc.prepare())
  handle('cloud:send', (token: unknown) => svc.send(token))
  handle('cloud:cancel', () => svc.cancel())
}
