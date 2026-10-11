/**
 * The sorter's cloud step as one main-process service: the nightly batch and the manual "Sort now".
 *
 * Consent lives here, not in the renderer:
 *   - The cloud step is off until he turns it on in Settings and confirms main's own native dialog
 *     (deps.confirm: count waiting, estimated cost, what goes to OpenAI); only then does main record
 *     the moment (optedInAt in config.json; changeSettings). Saving a key does not turn it on. Off
 *     means no nightly upload and no Sort now upload.
 *   - Sort now: prepare() runs the local sorter, picks the batch and returns its count, cost and a
 *     one-time token; send(token) sends exactly that batch (less anything no longer eligible), and
 *     refuses without the token of the batch prepared last, or once it is PREPARED_TTL_MS old. Before
 *     anything is claimed, main asks again with its native dialog; nothing goes unless he confirms.
 *     The nightly batch needs only the recorded opt-in.
 *   - Revocation: before every request and every retry the opt-in and the key are read again from
 *     main's state; if asking Luna was turned off or the key removed, the run stops there, its claims
 *     go and nothing further is sent.
 *   - At most NIGHTLY_LIMIT screenshots go to Luna per night window (schedule.ts nightOf), nightly
 *     and Sort now together. The count is kept in triage.db and taken when a screenshot is put into
 *     a request (store.ts admitForRequest), never at the claim: a run that dies before sending uses
 *     none of it, and moving the batch time or pressing Sort now cannot exceed it.
 *
 * What is sent: doubtful screenshots (screenshot file names only, luna.ts isScreenshotFile) Luna has
 * not answered for this model and prompt, newest first. A run claims them in one transaction, so two
 * processes never send the same one. Just before each request, each one is re-read and must still hash
 * to the hash it was classified under (a regular file, not a link; images.ts readVerified), and must
 * still be eligible (no decision of his, not answered in review); otherwise it is not sent. A retry
 * re-checks eligibility the same way and drops what is no longer eligible; if nothing is left, it is
 * not made.
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
import { buildLunaRequest, estimateCost, LUNA, LunaResponseError, REASON_MAX, parseLunaResponse, planChunks, selectForCloud, type CloudCandidate, type CostEstimate, type LunaItem } from './luna'
import { clipRedacted, LunaHttpError, pool, postLuna, redact, type HttpPost } from './client'
import type { LunaRequest } from './luna'
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

export type CloudSkip = 'off' | 'no-key' | 'revoked' | 'offline' | 'nothing-doubtful' | 'key-rejected' | 'cancelled' | 'limit-reached' | 'not-prepared' | 'not-confirmed'

/** What main's native confirm dialog shows (index.ts raises it with dialog.showMessageBox on the main window). */
export type ConsentPrompt = { kind: 'turn-on' | 'send'; count: number; estimate: CostEstimate; message: string; detail: string; confirmLabel: string }

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
  /** Main's native confirm (parent: the main window); true only when he pressed the confirm button. */
  confirm: (p: ConsentPrompt) => Promise<boolean>
  log?: (line: string) => void
  thresholds?: Thresholds
  now?: () => Date
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  endpoint?: string
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`
const usd = (x: number): string => (x < 0.01 ? 'under $0.01' : `about $${x.toFixed(2)}`)
/** The plain disclosure in every consent dialog: what leaves the Mac. */
const DISCLOSURE = `For each screenshot, OpenAI (${LUNA.model}) receives the picture, resized to ${LUNA.longEdge} pixels on its long edge, with the app name and window title from its file name. Window titles can name documents, people or folders. The file’s folder and the text read from the picture are not sent.`

/** The dialog for turning the cloud step on: what is waiting now and what a night can cost. */
export function turnOnPrompt(waiting: number, leftTonight: number): ConsentPrompt {
  const now = Math.min(waiting, leftTonight)
  const estimate = estimateCost(now)
  return {
    kind: 'turn-on',
    count: now,
    estimate,
    message: 'Turn on asking Luna?',
    detail: `${plural(waiting, 'doubtful screenshot')} ${waiting === 1 ? 'is' : 'are'} waiting now; ${plural(now, 'screenshot')} would go at the next sort. Estimated cost: ${usd(estimate.usd)}. At most ${NIGHTLY_LIMIT.toLocaleString('en-GB')} screenshots a night (${usd(estimateCost(NIGHTLY_LIMIT).usd)}).\n\n${DISCLOSURE}`,
    confirmLabel: 'Turn on'
  }
}

/** The dialog before a Sort now send: this batch's count and estimated cost. */
export function sendPrompt(count: number): ConsentPrompt {
  const estimate = estimateCost(count)
  return {
    kind: 'send',
    count,
    estimate,
    message: `Send ${plural(count, 'screenshot')} to Luna?`,
    detail: `${plural(count, 'screenshot')} the sorter could not call will go to OpenAI in ${plural(estimate.requests, 'request')}. Estimated cost: ${usd(estimate.usd)}.\n\n${DISCLOSURE}`,
    confirmLabel: `Send ${count.toLocaleString('en-GB')}`
  }
}
const SCOPE: CloudScope = { sorterVersion: SORTER_VERSION, model: LUNA.model, promptVersion: LUNA.promptVersion }

export class CloudSorter {
  private phase: CloudStatus['phase'] = 'idle'
  private done = 0
  private total = 0
  private abort: AbortController | null = null
  /** Stops the running batch because the key changed ('no-key' removed, 'revoked' replaced); null when idle. */
  private revokeRun: ((why: 'no-key' | 'revoked') => void) | null = null
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

  /**
   * The key was removed or a key was saved (Settings). A run is bound to the key it started with, so
   * the running batch, if any, stops at once: no further request or retry, its claims released.
   */
  keyChanged(change: 'cleared' | 'saved'): void {
    if (!this.revokeRun) return
    this.log(`the OpenAI key was ${change === 'cleared' ? 'removed' : 'changed'}: stopping the run`)
    this.revokeRun(change === 'cleared' ? 'no-key' : 'revoked')
  }

  /** Turning the cloud step on: main's own dialog with what is waiting and the cost; true when he confirms. */
  async consentToTurnOn(): Promise<boolean> {
    const waiting = this.candidates().list.length
    const leftTonight = Math.max(0, NIGHTLY_LIMIT - this.withStore((s) => s.allowanceUsed(nightOf(this.now()))))
    const ok = await this.deps.confirm(turnOnPrompt(waiting, leftTonight)).catch(() => false)
    this.log(`turning on: ${ok ? 'confirmed' : 'not confirmed'}`)
    return ok === true
  }

  /**
   * The opt-in and the key, read again from main's state; the reason to stop when asking Luna was
   * turned off, the key is gone, or it is no longer the key the run started with. Read before every
   * request and every retry.
   */
  private liveConsent(runKey: string): { ok: true } | { revoked: 'off' | 'no-key' | 'revoked' } {
    let enabled = false
    try {
      enabled = this.deps.settings().enabled === true
    } catch {
      enabled = false
    }
    if (!enabled) return { revoked: 'off' }
    const key = this.safeKey()
    if (!key) return { revoked: 'no-key' }
    return key === runKey ? { ok: true } : { revoked: 'revoked' }
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
          : await this.runCloud({ trigger: 'manual', local: null, only: p.hashes, confirm: true })
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

  private async runCloud(o: { trigger: CloudRunSummary['trigger']; local: CloudRunSummary['local']; only?: string[]; confirm?: boolean }): Promise<CloudRunSummary> {
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
    let wanted = selectForCloud(pool0, NIGHTLY_LIMIT)
    if (!wanted.length) return finish({ skipped: 'nothing-doubtful', stayedDoubtful: list.length })
    if (o.confirm) {
      // a manual send goes only after main's own dialog returns OK
      const ok = await this.deps.confirm(sendPrompt(wanted.length)).catch(() => false)
      if (ok !== true) return finish({ skipped: 'not-confirmed', stayedDoubtful: list.length })
      if (this.busy()) return finish({ error: 'The sorter is already running.' })
      const after = this.candidates()
      const still = new Set(after.list.map((c) => c.hash))
      wanted = wanted.filter((c) => still.has(c.hash))
      if (!wanted.length) return finish({ skipped: 'nothing-doubtful', stayedDoubtful: after.list.length })
    }

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
    let revoked: 'off' | 'no-key' | 'revoked' | null = null
    let chunkError: string | null = null
    const refused = new Map<NotSent, number>()
    const refuse = (why: NotSent, n = 1): void => void refused.set(why, (refused.get(why) ?? 0) + n)
    // revocation: the opt-in and the key from main's state; when either has gone, or the key is no
    // longer the one this run started with, stop the whole run (requests only ever carry `key`)
    const consent = (): void => {
      const c = this.liveConsent(key)
      if ('ok' in c) return
      revoked ??= c.revoked
      ctl.abort()
      throw new LunaHttpError(c.revoked === 'off' ? 'Asking Luna was turned off' : c.revoked === 'no-key' ? 'The OpenAI key was removed' : 'The OpenAI key was changed', 'revoked')
    }
    // a key change signalled from Settings stops the run at once, in-flight requests included
    this.revokeRun = (why) => {
      revoked ??= why
      ctl.abort()
    }
    // anything that may be stored, shown or logged is redacted against the run's key and the stored one
    const scrub = (text: string): string => redact(text, key, this.safeKey())
    const counts = { asked: 0, answered: 0, keep: 0, throwaway: 0 }
    try {
      await pool(
        planChunks(selected, LUNA.chunkSize),
        LUNA.concurrency,
        async (chunk) => {
          if (ctl.signal.aborted) return
          try {
            consent()
          } catch {
            return
          }
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
          let current = items
          const last: { req: LunaRequest | null } = { req: null }
          try {
            const json = await postLuna(null, {
              key,
              http: this.deps.http,
              endpoint: this.deps.endpoint,
              signal: ctl.signal,
              sleep: this.deps.sleep,
              onRetry: (attempt, why, wait) => this.log(`retry ${attempt} after ${why}, waiting ${wait} ms`),
              // before the first attempt and before every retry: consent and key again (else stop the run),
              // then eligibility per item (he may have decided or answered one meanwhile), and tonight's
              // allowance, counted here for what goes into the request (store.ts admitForRequest)
              before: (attempt) => {
                consent()
                const { admitted, overLimit } = this.withStore((s) => s.admitForRequest(current.map((i) => i.hash), { ...SCOPE, runId, night, limit: NIGHTLY_LIMIT }))
                const keep = new Set(admitted)
                const next = current.filter((i) => keep.has(i.hash))
                if (overLimit) refuse('limit-reached', overLimit)
                if (current.length - next.length - overLimit > 0) refuse('no-longer-eligible', current.length - next.length - overLimit)
                current = next
                if (!current.length) {
                  last.req = null
                  if (attempt > 1) this.log(`retry ${attempt - 1} not made: nothing in it is still waiting for Luna`)
                  return 'skip'
                }
                last.req = buildLunaRequest(current)
                if (attempt === 1) counts.asked += last.req.ids.size
                return { body: last.req.body, key }
              }
            })
            const req = last.req as LunaRequest | null
            if (json === null || !req) return
            const parsed = parseLunaResponse(json, req.ids)
            const askedAt = new Date().toISOString()
            const answers: CloudAnswerRow[] = []
            const proposals: Array<CascadeRow & { hash: string }> = []
            for (const [hash, raw] of parsed.answers) {
              // whatever the model wrote, the key never reaches the database or the renderer
              const a = { ...raw, reason: clipRedacted(scrub(raw.reason), REASON_MAX) } // redact first, then shorten
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
            if (e instanceof LunaHttpError && (e.kind === 'offline' || e.kind === 'auth' || e.kind === 'rate' || e.kind === 'cancelled' || e.kind === 'revoked')) {
              fatal ??= e
              ctl.abort()
            } else {
              chunkError = scrub(e instanceof LunaHttpError || e instanceof LunaResponseError ? e.message : 'Luna’s answer could not be read')
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
      this.revokeRun = null
      this.phase = 'idle'
      this.done = 0
      this.total = 0
      // claims go (unsent ones too); the allowance already holds only what went into a request
      this.withStore((s) => s.releaseClaims(runId))
    }
    for (const [why, n] of refused) this.log(`${n} screenshot(s) not sent: ${REFUSAL_WORDS[why]}`)
    const stayedDoubtful = list.length - counts.keep - counts.throwaway
    const r = revoked as 'off' | 'no-key' | 'revoked' | null
    if (r) return finish({ ...counts, stayedDoubtful, skipped: r })
    const f = fatal as LunaHttpError | null
    if (f) {
      const skipped: CloudSkip | null = f.kind === 'offline' ? 'offline' : f.kind === 'auth' ? 'key-rejected' : f.kind === 'cancelled' ? 'cancelled' : null
      return finish({ ...counts, stayedDoubtful, skipped, error: skipped === 'offline' || skipped === 'cancelled' ? null : scrub(f.message) })
    }
    return finish({ ...counts, stayedDoubtful, error: chunkError })
  }
}

type NotSent = VerifyRefusal | 'no-longer-eligible' | 'limit-reached'
/** Log words for a screenshot that was not sent (never its path or name). */
const REFUSAL_WORDS: Record<NotSent, string> = {
  'limit-reached': 'tonight’s limit was reached',
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
    case 'not-confirmed':
      return `Nothing was sent: you did not confirm.${waiting}`
    case 'off':
      return s.asked
        ? `Stopped after asking Luna about ${plural(s.asked, 'screenshot')}: asking Luna was turned off.${waiting}`
        : `Luna was not asked: asking Luna is turned off.${waiting}`
    case 'limit-reached':
      return `Luna was not asked: it has had ${NIGHTLY_LIMIT.toLocaleString('en-GB')} screenshots tonight, the most per night.${waiting}`
    case 'nothing-doubtful':
      return 'Nothing doubtful was waiting for Luna.'
    case 'no-key':
      return s.asked
        ? `Stopped after asking Luna about ${plural(s.asked, 'screenshot')}: the OpenAI key was removed.${waiting}`
        : `Luna was not asked: no OpenAI key is saved.${waiting}`
    case 'revoked':
      return `Stopped${s.asked ? ` after asking Luna about ${plural(s.asked, 'screenshot')}` : ''}: the OpenAI key was changed. The next run uses the new key.${waiting}`
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

/**
 * A settings change from the renderer. Turning the cloud step on is recorded only after main's own
 * dialog (consentToTurnOn) returns OK; declined, everything else in the patch still applies.
 */
export async function changeSettings(svc: Pick<CloudSorter, 'consentToTurnOn'>, patch: unknown, current: () => StoredCloudSettings, save: (s: StoredCloudSettings) => void, now: () => Date): Promise<void> {
  let p: Record<string, unknown> = patch && typeof patch === 'object' ? { ...(patch as Record<string, unknown>) } : {}
  if (p.enabled === true && !normaliseCloudSettings(current()).enabled && !(await svc.consentToTurnOn())) {
    const { enabled: _drop, ...rest } = p // eslint-disable-line @typescript-eslint/no-unused-vars
    p = rest
  }
  save(applySettingsPatch(current(), p, now())) // read again: the dialog may have stood open a while
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
    if (r.saved) svc.keyChanged('saved') // a running batch is bound to the key it started with
    return { ok: r.ok, saved: r.saved, error: r.error, status: svc.status() }
  })
  handle('cloud:clear-key', () => {
    key.clear()
    svc.keyChanged('cleared')
    return svc.status()
  })
  // only on/off (his opt-in, recorded here with its time after main's own dialog) and the batch time can be set; the limit is fixed
  handle('cloud:set-settings', async (patch: unknown) => {
    await changeSettings(svc, patch, current, saveSettings, () => new Date())
    return svc.status()
  })
  handle('cloud:prepare', () => svc.prepare())
  handle('cloud:send', (token: unknown) => svc.send(token))
  handle('cloud:cancel', () => svc.cancel())
}
