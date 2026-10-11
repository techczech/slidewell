/**
 * The sorter's cloud step as one main-process service: the nightly batch and the manual "Sort now".
 * It asks one of two providers, chosen in Settings: OpenAI's Luna (the default) or Anthropic's Haiku
 * (provider.ts). Everything below is the same for both and there is one of each: one service, one
 * schedule, one nightly allowance, one prepared batch.
 *
 * Consent lives here, not in the renderer, and it is per provider:
 *   - The cloud step is off until he turns it on in Settings and confirms main's own native dialog
 *     (deps.confirm: count waiting, estimated cost, which company receives what); only then does main
 *     record the moment for that provider (optedInAt for OpenAI, anthropicOptedInAt for Anthropic, in
 *     config.json; changeSettings). Saving a key does not turn it on. Off means no nightly upload and
 *     no Sort now upload. It is on only while the provider selected in Settings has a recorded opt-in.
 *   - Opting in to one provider is not consent to the other. Choosing the other provider while the
 *     cloud step is on raises main's dialog again, naming that company; declined, nothing changes.
 *     Turning the cloud step off clears both opt-ins.
 *   - Sort now: prepare() runs the local sorter, picks the batch and returns its count, cost and a
 *     one-time token; send(token) sends exactly that batch (less anything no longer eligible), and
 *     refuses without the token of the batch prepared last, once it is PREPARED_TTL_MS old, or when
 *     the provider selected now is not the one the batch was prepared for. Before anything is
 *     claimed, main asks again with its native dialog; nothing goes unless he confirms.
 *     The nightly batch needs only the recorded opt-in.
 *   - Revocation: a run is bound to the provider and the key it started with. Before every request
 *     and every retry the selected provider, its opt-in and its key are read again from main's state;
 *     if the provider was changed, asking was turned off, or the key was removed or replaced, the run
 *     stops there, its claims go and nothing further is sent.
 *   - At most NIGHTLY_LIMIT screenshots go to a cloud model per night window (schedule.ts nightOf):
 *     nightly and Sort now together, and both providers together (the count has no provider in it).
 *     The count is kept in triage.db and taken when a screenshot is put into a request (store.ts
 *     admitForRequest), never at the claim: a run that dies before sending uses none of it, and moving
 *     the batch time, pressing Sort now or changing provider cannot exceed it.
 *
 * What is sent: doubtful screenshots (screenshot file names only, luna.ts isScreenshotFile) that
 * neither provider has answered under its current model and prompt, newest first; a screenshot one
 * provider has answered is not sent to the other. A run claims them in one transaction, so two
 * processes never send the same one. Just before each request, each one is re-read and must still hash
 * to the hash it was classified under (a regular file, not a link; images.ts readVerified), and must
 * still be eligible (no decision of his, not answered in review); otherwise it is not sent. A retry
 * re-checks eligibility the same way and drops what is no longer eligible; if nothing is left, it is
 * not made.
 * The model's answers are redacted (no key of either provider) before they are stored or shown, then
 * go through the keep-bias in cascade.ts and are recorded with decided_by 'luna' or 'haiku' and the
 * model id. No key, or offline: skipped, items stay doubtful.
 *
 * A key comes from its provider's ApiKeyStore (key-store.ts, deps.keys) at call time and from nowhere
 * else; nothing here stores, returns or logs it, and every message that may reach a log, the database
 * or the renderer goes through redact() against the keys of both providers.
 */
import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { loadUndecided, SorterStore, type CloudAnswerRow, type CloudPending, type CloudScope } from '../store'
import { DEFAULT_THRESHOLDS, SORTER_VERSION, type Thresholds } from '../decide'
import { applyCloud, type CascadeRow } from './cascade'
import { LunaResponseError, REASON_MAX, planChunks, selectForCloud, type CloudCandidate, type CostEstimate, type LunaItem } from './luna'
import { clipRedacted, LunaHttpError, pool, postCloud, redact, type HttpPost } from './client'
import type { LunaRequest } from './luna'
import { DEFAULT_PROVIDER, isProviderId, PROVIDER_IDS, providerOf, PROVIDERS, type CloudProvider, type ProviderId } from './provider'
import { readVerified, type VerifyRefusal } from './images'
import { DEFAULT_BATCH_TIME, isBatchDue, nextSlot, nightOf, normaliseBatchTime } from './schedule'

/** Screenshots sent to a cloud model per night window: nightly and Sort now together, both providers together. Fixed; not a setting. */
export const NIGHTLY_LIMIT = 300
/** How long a prepared Sort now batch can be sent. */
export const PREPARED_TTL_MS = 10 * 60 * 1000

/** The settings as the service reads them. `enabled` is true only after his recorded opt-in to `provider`. */
export type CloudSettings = { enabled: boolean; batchTime: string; provider: ProviderId }
/**
 * What config.json stores for them. `optedInAt` is his opt-in to OpenAI (the name ticket 07 gave it),
 * `anthropicOptedInAt` his opt-in to Anthropic; `provider` is absent in a config written before there
 * were two, which means OpenAI.
 */
export type StoredCloudSettings = { provider?: ProviderId; optedInAt?: string | null; anthropicOptedInAt?: string | null; batchTime?: string }

const OPT_IN_FIELD: Record<ProviderId, 'optedInAt' | 'anthropicOptedInAt'> = { openai: 'optedInAt', anthropic: 'anthropicOptedInAt' }
type Raw = StoredCloudSettings | Record<string, unknown> | undefined

/** The provider selected in the stored settings (OpenAI when none or an unknown one is stored). */
export function storedProvider(raw: Raw): ProviderId {
  const p = ((raw ?? {}) as Record<string, unknown>).provider
  return isProviderId(p) ? p : DEFAULT_PROVIDER
}

/** Whether the stored settings hold his opt-in to this provider (a readable time in its own field). */
export function optedIn(raw: Raw, provider: ProviderId): boolean {
  const v = ((raw ?? {}) as Record<string, unknown>)[OPT_IN_FIELD[provider]]
  return typeof v === 'string' && Number.isFinite(Date.parse(v))
}

export function normaliseCloudSettings(raw: Raw): CloudSettings {
  const r = (raw ?? {}) as Record<string, unknown>
  const provider = storedProvider(raw)
  return { enabled: optedIn(raw, provider), batchTime: normaliseBatchTime(r.batchTime ?? DEFAULT_BATCH_TIME), provider }
}

/**
 * A settings change, as what to store. `provider` selects a provider (an unknown one is ignored);
 * `enabled: true` records the opt-in now for the provider the patch leaves selected (kept if already
 * there) and for no other; `enabled: false` clears both opt-ins; `batchTime` is normalised. Nothing
 * else is read. Selecting a provider never opts in to it: without its own opt-in the result is off.
 * Whether he confirmed the dialog for that provider is changeSettings' business, which is the only
 * caller outside tests.
 */
export function applySettingsPatch(cur: StoredCloudSettings, patch: unknown, now: Date): Required<StoredCloudSettings> {
  const p = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {}
  const provider = isProviderId(p.provider) ? p.provider : storedProvider(cur)
  const out: Required<StoredCloudSettings> = {
    provider,
    optedInAt: optedIn(cur, 'openai') ? (cur.optedInAt ?? null) : null,
    anthropicOptedInAt: optedIn(cur, 'anthropic') ? (cur.anthropicOptedInAt ?? null) : null,
    batchTime: normaliseBatchTime(cur.batchTime ?? DEFAULT_BATCH_TIME)
  }
  if (p.enabled === true && !out[OPT_IN_FIELD[provider]]) out[OPT_IN_FIELD[provider]] = now.toISOString()
  if (p.enabled === false) {
    out.optedInAt = null
    out.anthropicOptedInAt = null
  }
  if (p.batchTime !== undefined) out.batchTime = normaliseBatchTime(p.batchTime)
  return out
}

export type CloudSkip = 'off' | 'no-key' | 'revoked' | 'provider-changed' | 'offline' | 'nothing-doubtful' | 'key-rejected' | 'cancelled' | 'limit-reached' | 'not-prepared' | 'not-confirmed'

/**
 * What main's native confirm dialog shows (index.ts raises it with dialog.showMessageBox on the main
 * window). `provider` is the one the dialog names and the only one a confirmation counts for.
 */
export type ConsentPrompt = { kind: 'turn-on' | 'send'; provider: ProviderId; count: number; estimate: CostEstimate; message: string; detail: string; confirmLabel: string }

export type CloudRunSummary = {
  at: string
  trigger: 'nightly' | 'manual'
  /** The provider this run asked or would have asked (absent in a summary stored before there were two: OpenAI). */
  provider?: ProviderId
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
  /** The provider this batch was prepared for; send(token) refuses when another is selected by then. */
  provider: ProviderId
  /** Doubtful screenshots no cloud model has answered yet. */
  doubtful: number
  /** How many a send would ask about (doubtful, within what is left tonight). */
  toSend: number
  /** The per-night limit. */
  cap: number
  /** What is left of tonight's limit. */
  leftTonight: number
  estimate: CostEstimate
  /** The words before the cost figure and a sentence after it ('' when none), for the provider. */
  costLabel: string
  costNote: string
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
  /** Whether the selected provider's key is saved. No key ever leaves main. */
  hasKey: boolean
  encryptionAvailable: boolean
  settings: CloudSettings
  nightlyLimit: number
  lastRun: CloudRunSummary | null
  nextRunAt: string | null
  /** The selected provider's model, short name and company. */
  model: string
  name: string
  company: string
  longEdge: number
  /** Both providers, for the choice and the two key rows in Settings. */
  providers: Array<{ id: ProviderId; name: string; company: string; model: string; hasKey: boolean }>
}

export type CloudState = { lastRunAt: string | null; since: string | null; lastRun: CloudRunSummary | null }

/** One provider's key as the service may use it (an ApiKeyStore is one). */
export type KeyAccess = { get(): string | null; has(): boolean; encryptionAvailable(): boolean }

export type CloudDeps = {
  wellRoot: () => string
  /** The local sorter (sorter/service.ts sortUndecided). */
  sortLocal: () => Promise<{ ok: boolean; sorted?: number; error?: string }>
  /** The local sorter has a current model with enough held-back evidence to run unattended. */
  canSortLocal: () => boolean
  /** Each provider's own key store. A request to a provider only ever carries the key from its entry. */
  keys: Record<ProviderId, KeyAccess>
  online: () => boolean
  http: HttpPost
  /** Shrink verified bytes for sending (images.ts shrinkForLuna; the same picture for either provider). */
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
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`
const usd = (x: number): string => (x < 0.01 ? 'under $0.01' : `about $${x.toFixed(2)}`)
/** The plain disclosure in every consent dialog: which company receives what. */
const disclosure = (p: CloudProvider): string =>
  `For each screenshot, ${p.company} (${p.model}) receives the picture, resized to ${p.longEdge} pixels on its long edge, with the app name and window title from its file name. Window titles can name documents, people or folders. The file’s folder and the text read from the picture are not sent.`
const costNote = (p: CloudProvider): string => (p.costNote ? ` ${p.costNote}` : '')

/**
 * The dialog for turning the cloud step on for a provider: what is waiting now and what a night can
 * cost. `insteadOf` is the provider being asked until now, when this is a change of provider while
 * the cloud step is on.
 */
export function turnOnPrompt(waiting: number, leftTonight: number, provider: CloudProvider = PROVIDERS[DEFAULT_PROVIDER], insteadOf: CloudProvider | null = null): ConsentPrompt {
  const now = Math.min(waiting, leftTonight)
  const estimate = provider.estimateCost(now)
  const change = insteadOf ? `Until now ${insteadOf.company}’s ${insteadOf.name} was asked. From now on the screenshots go to ${provider.company} instead; this is a separate agreement.\n\n` : ''
  return {
    kind: 'turn-on',
    provider: provider.id,
    count: now,
    estimate,
    message: insteadOf ? `Ask ${provider.name} instead of ${insteadOf.name}?` : `Turn on asking ${provider.name}?`,
    detail: `${change}${plural(waiting, 'doubtful screenshot')} ${waiting === 1 ? 'is' : 'are'} waiting now; ${plural(now, 'screenshot')} would go at the next sort. ${provider.costLabel}: ${usd(estimate.usd)}. At most ${NIGHTLY_LIMIT.toLocaleString('en-GB')} screenshots a night (${usd(provider.estimateCost(NIGHTLY_LIMIT).usd)}).${costNote(provider)}\n\n${disclosure(provider)}`,
    confirmLabel: insteadOf ? `Ask ${provider.name}` : 'Turn on'
  }
}

/** The dialog before a Sort now send: this batch's count and estimated cost, and the company it goes to. */
export function sendPrompt(count: number, provider: CloudProvider = PROVIDERS[DEFAULT_PROVIDER]): ConsentPrompt {
  const estimate = provider.estimateCost(count)
  return {
    kind: 'send',
    provider: provider.id,
    count,
    estimate,
    message: `Send ${plural(count, 'screenshot')} to ${provider.name}?`,
    detail: `${plural(count, 'screenshot')} the sorter could not call will go to ${provider.company} in ${plural(estimate.requests, 'request')}. ${provider.costLabel}: ${usd(estimate.usd)}.${costNote(provider)}\n\n${disclosure(provider)}`,
    confirmLabel: `Send ${count.toLocaleString('en-GB')}`
  }
}

/** What counts for a provider's run: its own model + prompt, and the other provider's as already answered. */
function scopeOf(p: CloudProvider): CloudScope {
  return { sorterVersion: SORTER_VERSION, model: p.model, promptVersion: p.promptVersion, others: PROVIDER_IDS.filter((id) => id !== p.id).map((id) => ({ model: PROVIDERS[id].model, promptVersion: PROVIDERS[id].promptVersion })) }
}

/** Why a run stops before its next request. */
type Revoked = 'off' | 'no-key' | 'revoked' | 'provider-changed'

export class CloudSorter {
  private phase: CloudStatus['phase'] = 'idle'
  private done = 0
  private total = 0
  private abort: AbortController | null = null
  /** The running batch: the provider it is bound to and how to stop it at once (key or provider changed); null when idle. */
  private running: { provider: ProviderId; revoke: (why: Revoked) => void } | null = null
  /** The batch prepare() showed him, bound to the provider it was prepared for. */
  private prepared: { token: string; hashes: string[]; expiresAt: number; provider: ProviderId } | null = null
  /**
   * Counts every provider change and, per provider, every key change signalled from Settings. A send
   * waiting on main's dialog has used up `prepared` and is not yet `running`, so neither can stop it;
   * it compares these counts across the dialog instead and sends nothing when one has moved, even if
   * the provider selected and the key stored are by then the same as before.
   */
  private providerChanges = 0
  private keyChanges: Record<ProviderId, number> = { openai: 0, anthropic: 0 }

  constructor(private deps: CloudDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date()
  }

  private log(line: string): void {
    this.deps.log?.(`[sorter-cloud] ${redact(line, ...this.safeKeys())}`)
  }

  /** One provider's stored key (null when none, or when it cannot be read). */
  private safeKey(id: ProviderId): string | null {
    try {
      return this.deps.keys[id].get()
    } catch {
      return null
    }
  }

  /** The stored keys of both providers, for redaction: neither may appear in anything stored, shown or logged. */
  private safeKeys(): Array<string | null> {
    return PROVIDER_IDS.map((id) => this.safeKey(id))
  }

  /** The provider selected in Settings now. */
  private selected(): CloudProvider {
    return providerOf(this.deps.settings().provider)
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
    const provider = providerOf(settings.provider)
    return {
      phase: this.phase,
      done: this.done,
      total: this.total,
      hasKey: this.deps.keys[provider.id].has(),
      encryptionAvailable: this.deps.keys[provider.id].encryptionAvailable(),
      settings,
      nightlyLimit: NIGHTLY_LIMIT,
      lastRun: this.deps.state().lastRun,
      nextRunAt: settings.enabled ? nextSlot(this.now(), settings.batchTime).toISOString() : null,
      model: provider.model,
      name: provider.name,
      company: provider.company,
      longEdge: provider.longEdge,
      providers: PROVIDER_IDS.map((id) => ({ id, name: PROVIDERS[id].name, company: PROVIDERS[id].company, model: PROVIDERS[id].model, hasKey: this.deps.keys[id].has() }))
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
   * A provider's key was removed or a key was saved for it (Settings). A run is bound to the key it
   * started with, so a running batch that asks that provider stops at once: no further request or
   * retry, its claims released. A change to the other provider's key does not concern the run.
   */
  keyChanged(provider: ProviderId, change: 'cleared' | 'saved'): void {
    this.keyChanges[provider]++
    if (!this.running || this.running.provider !== provider) return
    this.log(`the ${PROVIDERS[provider].company} key was ${change === 'cleared' ? 'removed' : 'changed'}: stopping the run`)
    this.running.revoke(change === 'cleared' ? 'no-key' : 'revoked')
  }

  /**
   * Another provider was selected in Settings. A batch prepared for the earlier one can no longer be
   * sent, and a running batch (bound to the provider it started with) stops at once.
   */
  providerChanged(): void {
    this.providerChanges++
    this.prepared = null
    const now = this.deps.settings().provider
    if (!this.running || this.running.provider === now) return
    this.log('the provider was changed: stopping the run')
    this.running.revoke('provider-changed')
  }

  /**
   * Turning the cloud step on for a provider (or changing to it while on, `insteadOf` being the one
   * asked until now): main's own dialog with what is waiting, the cost and the company that receives
   * the pictures; true only when he confirms. A confirmation counts for `id` and no other provider.
   */
  async consentToTurnOn(id: ProviderId = this.selected().id, insteadOf: ProviderId | null = null): Promise<boolean> {
    const provider = providerOf(id)
    const waiting = this.candidates(provider).list.length
    const leftTonight = Math.max(0, NIGHTLY_LIMIT - this.withStore((s) => s.allowanceUsed(nightOf(this.now()))))
    const ok = await this.deps.confirm(turnOnPrompt(waiting, leftTonight, provider, insteadOf && insteadOf !== id ? providerOf(insteadOf) : null)).catch(() => false)
    this.log(`turning on asking ${provider.name}: ${ok ? 'confirmed' : 'not confirmed'}`)
    return ok === true
  }

  /**
   * The selected provider, its opt-in and its key, read again from main's state; the reason to stop
   * when another provider is selected by now, asking was turned off, the key is gone, or it is no
   * longer the key the run started with. Read before every request and every retry.
   */
  private liveConsent(provider: CloudProvider, runKey: string): { ok: true } | { revoked: Revoked } {
    let settings: CloudSettings | null = null
    try {
      settings = this.deps.settings()
    } catch {
      settings = null
    }
    if (!settings) return { revoked: 'off' }
    if (settings.provider !== provider.id) return { revoked: 'provider-changed' }
    if (settings.enabled !== true) return { revoked: 'off' }
    const key = this.safeKey(provider.id)
    if (!key) return { revoked: 'no-key' }
    return key === runKey ? { ok: true } : { revoked: 'revoked' }
  }

  /** Doubtful screenshots no cloud model has answered, with a readable picture on this Mac. */
  private candidates(provider: CloudProvider): { list: CloudCandidate[]; pending: Map<string, CloudPending> } {
    const scope = scopeOf(provider)
    const pendingRows = this.withStore((s) => s.cloudPending(scope.sorterVersion, scope.model, scope.promptVersion, scope.others))
    const pending = new Map(pendingRows.map((p) => [p.hash, p]))
    if (!pending.size) return { list: [], pending }
    const list: CloudCandidate[] = []
    for (const s of loadUndecided(this.deps.wellRoot())) {
      if (!s.hash || !s.image || !pending.has(s.hash)) continue
      list.push({ hash: s.hash, proposal: 'doubtful', path: s.image.path, filename: s.facts.filename ?? '', app: s.facts.app ?? '', windowTitle: s.facts.windowTitle ?? '', takenAt: s.takenAt ?? '' })
    }
    // screenshots only (by file name); anything else never counts as waiting for a cloud model
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
    const first = this.selected()
    const none = (patch: Partial<CloudPreview>): CloudPreview => ({ local: { ok: false, message: '' }, provider: first.id, doubtful: 0, toSend: 0, cap: NIGHTLY_LIMIT, leftTonight: 0, estimate: first.estimateCost(0), costLabel: first.costLabel, costNote: first.costNote, blocked: null, token: null, message: '', ...patch })
    if (this.busy()) return none({ blocked: 'busy', message: 'The sorter is already running.' })
    let local: { ok: boolean; message: string }
    try {
      local = await this.runLocal()
    } finally {
      this.phase = 'idle'
      this.push()
    }
    // read after the local sort: the batch is prepared for the provider selected now
    const settings = this.deps.settings()
    const provider = providerOf(settings.provider)
    const { name, company } = provider
    const { list } = this.candidates(provider)
    const leftTonight = Math.max(0, NIGHTLY_LIMIT - this.withStore((s) => s.allowanceUsed(nightOf(this.now()))))
    const batch = selectForCloud(list, leftTonight)
    const toSend = batch.length
    const blocked: CloudPreview['blocked'] = !list.length
      ? 'nothing-doubtful'
      : !settings.enabled
        ? 'off'
        : !this.deps.keys[provider.id].has()
          ? 'no-key'
          : !this.deps.online()
            ? 'offline'
            : !toSend
              ? 'limit-reached'
              : null
    const waiting = plural(list.length, 'screenshot')
    const message =
      blocked === 'nothing-doubtful'
        ? `Nothing doubtful is waiting for ${name}.`
        : blocked === 'off'
          ? `${waiting} stay in Review: asking ${name} is turned off.`
          : blocked === 'no-key'
            ? `${waiting} stay in Review: no ${company} key is saved.`
            : blocked === 'offline'
              ? `${waiting} stay in Review: this Mac is offline.`
              : blocked === 'limit-reached'
                ? `${waiting} stay in Review: ${NIGHTLY_LIMIT.toLocaleString('en-GB')} screenshots have been sent tonight, the most per night.`
                : `Ask ${name} about ${plural(toSend, 'screenshot')}${toSend < list.length ? ` of ${list.length.toLocaleString('en-GB')} (${leftTonight.toLocaleString('en-GB')} left of tonight’s ${NIGHTLY_LIMIT.toLocaleString('en-GB')})` : ''}?`
    let token: string | null = null
    if (!blocked) {
      token = randomUUID()
      this.prepared = { token, hashes: batch.map((c) => c.hash), expiresAt: this.now().getTime() + PREPARED_TTL_MS, provider: provider.id }
    }
    return { local, provider: provider.id, doubtful: list.length, toSend, cap: NIGHTLY_LIMIT, leftTonight, estimate: provider.estimateCost(toSend), costLabel: provider.costLabel, costNote: provider.costNote, blocked, token, message }
  }

  /**
   * Sort now, step 2 (after his click): send the batch prepare() showed him. Refused without the
   * token of the batch prepared last, once it is PREPARED_TTL_MS old, or when the provider selected
   * now is not the one the batch was prepared for; a token is used once.
   */
  async send(token: unknown): Promise<CloudRunSummary> {
    const p = this.prepared
    let summary: CloudRunSummary
    if (!p || typeof token !== 'string' || token !== p.token) {
      summary = this.refused('manual', 'This send was not prepared here. Press Sort now and confirm the count first.', this.selected().id)
    } else {
      this.prepared = null
      summary =
        this.now().getTime() > p.expiresAt
          ? this.refused('manual', 'The prepared batch is too old. Press Sort now again to see the current count.', p.provider)
          : this.selected().id !== p.provider
            ? this.refused('manual', `The batch was prepared for ${PROVIDERS[p.provider].name}, and another provider is selected now. Press Sort now again.`, this.selected().id)
            : await this.runCloud({ trigger: 'manual', local: null, provider: p.provider, only: p.hashes, confirm: true })
    }
    this.deps.saveState({ lastRun: summary })
    this.push()
    return summary
  }

  private refused(trigger: CloudRunSummary['trigger'], error: string, provider: ProviderId): CloudRunSummary {
    this.log(`${trigger} send refused: not prepared`)
    const s: CloudRunSummary = { at: this.now().toISOString(), trigger, provider, local: null, asked: 0, answered: 0, keep: 0, throwaway: 0, stayedDoubtful: 0, skipped: 'not-prepared', error, message: '' }
    s.message = describe(s)
    return s
  }

  /** The nightly batch: local sorter, then the selected provider's model for what it left doubtful (within tonight's limit). */
  async runNightly(): Promise<CloudRunSummary> {
    this.deps.saveState({ lastRunAt: this.now().toISOString() }) // first, so a crash mid-run is not retried every minute
    let local: { ok: boolean; message: string }
    try {
      local = await this.runLocal()
    } finally {
      this.phase = 'idle'
    }
    // the provider selected once the local sort is done; runCloud binds the run to it
    const summary = await this.runCloud({ trigger: 'nightly', local, provider: this.selected().id })
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

  /**
   * One run, bound from here on to `o.provider` and to that provider's key as read below: every
   * request goes to that provider's endpoint with that key, or is not made.
   */
  private async runCloud(o: { trigger: CloudRunSummary['trigger']; local: CloudRunSummary['local']; provider: ProviderId; only?: string[]; confirm?: boolean }): Promise<CloudRunSummary> {
    const { trigger, local } = o
    const provider = providerOf(o.provider)
    const scope = scopeOf(provider)
    const at = this.now().toISOString()
    const base: CloudRunSummary = { at, trigger, provider: provider.id, local, asked: 0, answered: 0, keep: 0, throwaway: 0, stayedDoubtful: 0, skipped: null, error: null, message: '' }
    const finish = (patch: Partial<CloudRunSummary>): CloudRunSummary => {
      const s = { ...base, ...patch }
      s.message = describe(s)
      this.log(`${trigger} run (${provider.name}): asked ${s.asked}, answered ${s.answered} (keep ${s.keep}, throwaway ${s.throwaway}, still doubtful ${s.stayedDoubtful})${s.skipped ? `, skipped: ${s.skipped}` : ''}${s.error ? `, error: ${s.error}` : ''}`)
      return s
    }
    if (this.busy()) return finish({ error: 'The sorter is already running.' })
    const { list, pending } = this.candidates(provider)
    let pool0 = list
    if (o.only) {
      const byHash = new Map(list.map((c) => [c.hash, c]))
      pool0 = o.only.map((h) => byHash.get(h)).filter((c): c is CloudCandidate => Boolean(c))
    }
    if (!pool0.length) return finish({ skipped: 'nothing-doubtful', stayedDoubtful: list.length })
    // the opt-in read here is the selected provider's; a run for any other provider does not start
    const settings = this.deps.settings()
    if (settings.provider !== provider.id) return finish({ skipped: 'provider-changed', stayedDoubtful: list.length })
    if (!settings.enabled) return finish({ skipped: 'off', stayedDoubtful: list.length })
    const key = this.deps.keys[provider.id].get()
    // a key that is not this provider's kind is no key: it is never put into a request to this provider
    if (!key || provider.keyRule(key) !== null) return finish({ skipped: 'no-key', stayedDoubtful: list.length })
    if (!this.deps.online()) return finish({ skipped: 'offline', stayedDoubtful: list.length })
    let wanted = selectForCloud(pool0, NIGHTLY_LIMIT)
    if (!wanted.length) return finish({ skipped: 'nothing-doubtful', stayedDoubtful: list.length })
    if (o.confirm) {
      // a manual send goes only after main's own dialog, which names this provider, returns OK
      const providerChanges = this.providerChanges
      const keyChanges = this.keyChanges[provider.id]
      const ok = await this.deps.confirm(sendPrompt(wanted.length, provider)).catch(() => false)
      if (ok !== true) return finish({ skipped: 'not-confirmed', stayedDoubtful: list.length })
      if (this.busy()) return finish({ error: 'The sorter is already running.' })
      // the dialog may have stood open a while: the confirmation counts only for the provider it named
      // and only if no other provider was selected meanwhile, even one switched away from and back to
      if (this.providerChanges !== providerChanges) return finish({ skipped: 'provider-changed', stayedDoubtful: list.length })
      const live = this.liveConsent(provider, key)
      if (!('ok' in live)) return finish({ skipped: live.revoked, stayedDoubtful: list.length })
      // nor if this provider's key was removed or saved meanwhile, even when the same key is stored again
      if (this.keyChanges[provider.id] !== keyChanges) return finish({ skipped: 'revoked', stayedDoubtful: list.length })
      const after = this.candidates(provider)
      const still = new Set(after.list.map((c) => c.hash))
      wanted = wanted.filter((c) => still.has(c.hash))
      if (!wanted.length) return finish({ skipped: 'nothing-doubtful', stayedDoubtful: after.list.length })
    }

    // claim the batch in one transaction: tonight's limit and other runs (other processes too) are checked there
    const night = nightOf(this.now())
    const runId = randomUUID()
    const { claimed, leftBefore } = this.withStore((s) => s.claimForCloud(wanted.map((c) => c.hash), { ...scope, night, limit: NIGHTLY_LIMIT, runId, now: this.now() }))
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
    let revoked: Revoked | null = null
    let chunkError: string | null = null
    const refused = new Map<NotSent, number>()
    const refuse = (why: NotSent, n = 1): void => void refused.set(why, (refused.get(why) ?? 0) + n)
    // revocation: the selected provider, its opt-in and its key from main's state; when the provider
    // is another by now, the opt-in has gone, or the key is no longer the one this run started with,
    // stop the whole run (requests only ever carry `key`, and only ever go to `provider`)
    const consent = (): void => {
      const c = this.liveConsent(provider, key)
      if ('ok' in c) return
      revoked ??= c.revoked
      ctl.abort()
      throw new LunaHttpError(REVOKED_WORDS[c.revoked](provider), 'revoked')
    }
    // a key or provider change signalled from Settings stops the run at once, in-flight requests included
    this.running = {
      provider: provider.id,
      revoke: (why) => {
        revoked ??= why
        ctl.abort()
      }
    }
    // anything that may be stored, shown or logged is redacted against the run's key and the stored keys of both providers
    const scrub = (text: string): string => redact(text, key, ...this.safeKeys())
    const counts = { asked: 0, answered: 0, keep: 0, throwaway: 0 }
    try {
      await pool(
        planChunks(selected, provider.chunkSize),
        provider.concurrency,
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
            const json = await postCloud(null, {
              key,
              http: this.deps.http,
              wire: provider,
              signal: ctl.signal,
              sleep: this.deps.sleep,
              onRetry: (attempt, why, wait) => this.log(`retry ${attempt} after ${why}, waiting ${wait} ms`),
              // before the first attempt and before every retry: provider, consent and key again (else stop
              // the run), then eligibility per item (he may have decided or answered one meanwhile), and
              // tonight's allowance, counted here for what goes into the request (store.ts admitForRequest)
              before: (attempt) => {
                consent()
                const { admitted, overLimit } = this.withStore((s) => s.admitForRequest(current.map((i) => i.hash), { ...scope, runId, night, limit: NIGHTLY_LIMIT }))
                const keep = new Set(admitted)
                const next = current.filter((i) => keep.has(i.hash))
                if (overLimit) refuse('limit-reached', overLimit)
                if (current.length - next.length - overLimit > 0) refuse('no-longer-eligible', current.length - next.length - overLimit)
                current = next
                if (!current.length) {
                  last.req = null
                  if (attempt > 1) this.log(`retry ${attempt - 1} not made: nothing in it is still waiting for ${provider.name}`)
                  return 'skip'
                }
                last.req = provider.buildRequest(current)
                if (attempt === 1) counts.asked += last.req.ids.size
                return { body: last.req.body, key }
              }
            })
            const req = last.req as LunaRequest | null
            if (json === null || !req) return
            const parsed = provider.parseResponse(json, req.ids)
            const askedAt = new Date().toISOString()
            const answers: CloudAnswerRow[] = []
            const proposals: Array<CascadeRow & { hash: string }> = []
            for (const [hash, raw] of parsed.answers) {
              // whatever the model wrote, no key reaches the database or the renderer
              const a = { ...raw, reason: clipRedacted(scrub(raw.reason), REASON_MAX) } // redact first, then shorten
              answers.push({ hash, ...a, model: provider.model, promptVersion: provider.promptVersion, askedAt })
              const p = pending.get(hash)
              if (!p) continue
              const row = applyCloud({ proposal: 'doubtful', confidence: p.confidence, pKeep: p.pKeep, reason: p.reason, decidedBy: null }, a, provider, t)
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
              chunkError = scrub(e instanceof LunaHttpError || e instanceof LunaResponseError ? e.message : `${provider.name}’s answer could not be read`)
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
      this.running = null
      this.phase = 'idle'
      this.done = 0
      this.total = 0
      // claims go (unsent ones too); the allowance already holds only what went into a request
      this.withStore((s) => s.releaseClaims(runId))
    }
    for (const [why, n] of refused) this.log(`${n} screenshot(s) not sent: ${REFUSAL_WORDS[why]}`)
    const stayedDoubtful = list.length - counts.keep - counts.throwaway
    const r = revoked as Revoked | null
    if (r) return finish({ ...counts, stayedDoubtful, skipped: r })
    const f = fatal as LunaHttpError | null
    if (f) {
      const skipped: CloudSkip | null = f.kind === 'offline' ? 'offline' : f.kind === 'auth' ? 'key-rejected' : f.kind === 'cancelled' ? 'cancelled' : null
      return finish({ ...counts, stayedDoubtful, skipped, error: skipped === 'offline' || skipped === 'cancelled' ? null : scrub(f.message) })
    }
    return finish({ ...counts, stayedDoubtful, error: chunkError })
  }
}

const REVOKED_WORDS: Record<Revoked, (p: CloudProvider) => string> = {
  off: (p) => `Asking ${p.name} was turned off`,
  'no-key': (p) => `The ${p.company} key was removed`,
  revoked: (p) => `The ${p.company} key was changed`,
  'provider-changed': () => 'Another provider was selected'
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
  const { name, company } = providerOf(s.provider)
  const waiting = s.stayedDoubtful ? ` ${plural(s.stayedDoubtful, 'screenshot')} still need${s.stayedDoubtful === 1 ? 's' : ''} a look.` : ''
  switch (s.skipped) {
    case 'not-prepared':
      return `Nothing was sent. ${s.error ?? ''}`.trim()
    case 'not-confirmed':
      return `Nothing was sent: you did not confirm.${waiting}`
    case 'off':
      return s.asked
        ? `Stopped after asking ${name} about ${plural(s.asked, 'screenshot')}: asking ${name} was turned off.${waiting}`
        : `${name} was not asked: asking ${name} is turned off.${waiting}`
    case 'limit-reached':
      return `${name} was not asked: ${NIGHTLY_LIMIT.toLocaleString('en-GB')} screenshots have been sent tonight, the most per night.${waiting}`
    case 'nothing-doubtful':
      return `Nothing doubtful was waiting for ${name}.`
    case 'no-key':
      return s.asked
        ? `Stopped after asking ${name} about ${plural(s.asked, 'screenshot')}: the ${company} key was removed.${waiting}`
        : `${name} was not asked: no ${company} key is saved.${waiting}`
    case 'revoked':
      return `Stopped${s.asked ? ` after asking ${name} about ${plural(s.asked, 'screenshot')}` : ''}: the ${company} key was changed. The next run uses the new key.${waiting}`
    case 'provider-changed':
      return `Stopped${s.asked ? ` after asking ${name} about ${plural(s.asked, 'screenshot')}` : ''}: another provider was selected in Settings. Nothing more goes to ${company} from this run.${waiting}`
    case 'offline':
      return `${name} was not asked${s.answered ? ' about all of them' : ''}: this Mac was offline.${waiting}`
    case 'key-rejected':
      return `${company} did not accept the API key.${waiting}`
    case 'cancelled':
      return `Stopped.${waiting}`
  }
  if (s.error && !s.answered) return `${name} could not answer: ${s.error}.${waiting}`
  return `Asked ${name} about ${plural(s.asked, 'screenshot')}: ${s.keep.toLocaleString('en-GB')} keep, ${s.throwaway.toLocaleString('en-GB')} throwaway.${waiting}`
}

/**
 * A settings change from the renderer. The cloud step is on for a provider only after main's own
 * dialog naming that provider (consentToTurnOn) returns OK. That covers both ways there: turning it
 * on, and selecting another provider while it is on. Declined, the provider stays as it was and the
 * cloud step is not turned on; everything else in the patch (the batch time) still applies. While
 * the cloud step is off, a provider can be selected without a dialog: nothing is sent while it is off,
 * and turning it on afterwards asks for that provider. A provider he has already opted in to (and
 * not turned off since) is selected without a second dialog.
 */
export async function changeSettings(svc: Pick<CloudSorter, 'consentToTurnOn' | 'providerChanged'>, patch: unknown, current: () => StoredCloudSettings, save: (s: StoredCloudSettings) => void, now: () => Date): Promise<void> {
  let p: Record<string, unknown> = patch && typeof patch === 'object' ? { ...(patch as Record<string, unknown>) } : {}
  if (!isProviderId(p.provider)) delete p.provider // only the two ids select a provider
  const before = current()
  const from = storedProvider(before)
  const to = isProviderId(p.provider) ? p.provider : from
  const on = optedIn(before, from)
  const wantsOn = p.enabled === true || (p.enabled !== false && on)
  if (wantsOn && !optedIn(before, to)) {
    if (await svc.consentToTurnOn(to, on && to !== from ? from : null)) {
      p = { ...p, provider: to, enabled: true } // the opt-in is recorded for the provider the dialog named, whatever is stored by now
    } else {
      const { enabled: _on, provider: _to, ...rest } = p // eslint-disable-line @typescript-eslint/no-unused-vars
      p = rest
    }
  }
  const latest = current() // read again: the dialog may have stood open a while
  const next = applySettingsPatch(latest, p, now())
  save(next)
  if (next.provider !== storedProvider(latest)) svc.providerChanged()
}

/**
 * IPC for Settings › Screenshot sorter › cloud step. Types: src/preload/index.ts. Never returns a key.
 * A key is saved or removed for the provider the call names (one of the two ids, or it is refused):
 * there is no default and no guessing from the key, so a key cannot land in the other provider's store.
 */
export function registerCloudIpc(
  svc: CloudSorter,
  keys: Record<ProviderId, { set(k: unknown): { ok: boolean; saved: boolean; error?: string }; clear(): void }>,
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
  handle('cloud:set-key', (provider: unknown, k: unknown) => {
    if (!isProviderId(provider)) return { ok: false, saved: false, error: 'The key was not saved: no provider was named.', status: svc.status() }
    const r = keys[provider].set(k) // saving a key never turns the cloud step on
    if (r.saved) svc.keyChanged(provider, 'saved') // a running batch is bound to the key it started with
    return { ok: r.ok, saved: r.saved, error: r.error, status: svc.status() }
  })
  handle('cloud:clear-key', (provider: unknown) => {
    if (!isProviderId(provider)) return svc.status()
    keys[provider].clear()
    svc.keyChanged(provider, 'cleared')
    return svc.status()
  })
  // only the provider, on/off (his opt-in per provider, recorded here with its time after main's own dialog) and the batch time can be set; the limit is fixed
  handle('cloud:set-settings', async (patch: unknown) => {
    await changeSettings(svc, patch, current, saveSettings, () => new Date())
    return svc.status()
  })
  handle('cloud:prepare', () => svc.prepare())
  handle('cloud:send', (token: unknown) => svc.send(token))
  handle('cloud:cancel', () => svc.cancel())
}
