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
 *     no Sort now upload. It is on only while it is turned on and the provider selected in Settings
 *     has a recorded agreement (settings.ts).
 *   - Agreeing to one provider is not consent to the other. Choosing the other provider while the
 *     cloud step is on raises main's dialog again, naming that company; declined, nothing changes.
 *     Turning the cloud step off keeps the provider, both keys and both agreements, so turning it on
 *     again for a provider he has agreed to raises no dialog. Removing a provider's key withdraws his
 *     agreement to that provider (settings.ts withdrawAgreement). Turning it off (serviceChanged)
 *     drops the prepared batch and stops a running one.
 *   - The nightly batch is its own switch (`nightly`): it runs only while the cloud step is on and
 *     that switch is on. Sort now needs only the cloud step on.
 *   - Second opinions are a switch too (`secondOpinions`). Off, a provider is never asked about a
 *     screenshot the other one answered, in the nightly batch or in Sort now: such a screenshot is
 *     not eligible (store.ts eligibleSql), which is read again before every request. A change of the
 *     switch (secondOpinionsChanged) drops the prepared batch, like a change of provider.
 *   - Sort now: prepare() runs the local sorter, picks the batch and returns its count, cost and a
 *     one-time token; send(token) sends exactly that batch (less anything no longer eligible by the
 *     time main's dialog is raised, which gives the count that then goes), and
 *     refuses without the token of the batch prepared last, once it is PREPARED_TTL_MS old, or when
 *     the provider or the period selected now is not the one the batch was prepared for. Before
 *     anything is claimed, main asks again with its native dialog; nothing goes unless he confirms.
 *     The nightly batch needs only the recorded opt-in.
 *   - Sort now is limited to the period chosen in Settings (period.ts: the last 7, 30 or 90 days, or
 *     everything), by each screenshot's capture time. prepare() reads the stored period, works out the
 *     cut-off from this process's clock, runs the local sorter on that window only, and offers the
 *     cloud step only doubtful screenshots inside it. The window is kept with the prepared batch and
 *     send() uses that same window; the renderer supplies no period, date or list of screenshots. A
 *     stored period that is not one of the four prepares nothing (it is never read as everything). A
 *     change of period (periodChanged) drops the prepared batch, and a send waiting on main's dialog
 *     sends nothing when the period moved meanwhile. The nightly batch ignores the period: it takes
 *     everything, within the nightly limit.
 *   - What goes is the batch main's dialog counted, or nothing. After the dialog returns OK the batch
 *     is read again: if any screenshot in it is no longer eligible or no longer dated inside the
 *     window, nothing is sent and no allowance is used ('batch-changed'); he presses Sort now again.
 *     Once sending has started he is not asked again: each request, and each retry, re-reads the
 *     capture time of what it carries inside the admission transaction (store.ts admitForRequest),
 *     and a date that has left the window stops the run there ('date-changed'): that request is not
 *     made, no further one starts, and what earlier requests carried stays sent and counted. (One he
 *     decided or answered meanwhile is dropped from its request as before; that does not stop the run.)
 *     The same transaction holds the count to the allowance: the run's first request goes only if the
 *     run still holds every confirmed screenshot, each still eligible, and all of them fit in what is
 *     left tonight; otherwise nothing is admitted or counted, the run's claims go there and nothing
 *     is sent ('batch-changed'). A later request stops the run the same way when what the run has
 *     still to send no longer fits. Nothing is set aside for requests not yet made.
 *   - From the moment a run holds claims, everything it does runs under one cleanup: however it ends,
 *     the sorter is idle again and the run's claims are released. If the release itself fails, the
 *     sorter is still idle, and the run's result and the log say the claims were not released.
 *   - A prepared batch can be sent for PREPARED_TTL_MS. Its age is measured on a monotonic clock
 *     (deps.monotonic), so setting the Mac's clock back does not keep it alive; the wall clock is
 *     read as well, so time the Mac spent asleep counts. Both are checked when send() is called and
 *     again after main's dialog returns, before anything is claimed.
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
 * What is sent to the selected provider: doubtful screenshots (screenshot file names only, luna.ts
 * isScreenshotFile), newest first, of two kinds: those no provider has answered, and those the other
 * provider answered and was unsure about (a second opinion; counted and shown as their own number).
 * Never sent: one the selected provider has answered, one any provider answered with a decision, one
 * he has decided. So a screenshot goes to each provider at most once, and never again once both have
 * answered (store.ts eligibleSql); an answer counts under its provider's current model and prompt.
 * Second opinions use tonight's allowance like any other. A run claims them in one transaction, so
 * two processes never send the same one. Just before each request, each one is re-read and must still hash
 * to the hash it was classified under (a regular file, not a link; images.ts readVerified), and must
 * still be eligible (no decision of his, not answered in review); otherwise it is not sent. A retry
 * re-checks eligibility the same way and drops what is no longer eligible; if nothing is left, it is
 * not made.
 * The model's answers are redacted (no key of either provider) before they are stored or shown, then
 * go through the keep-bias in cascade.ts and are recorded with decided_by 'luna' or 'haiku' and the
 * model id, each in its own provider's row; a second opinion never replaces the first provider's row.
 * No key, or offline: skipped, items stay doubtful.
 *
 * A key comes from its provider's ApiKeyStore (key-store.ts, deps.keys) at call time and from nowhere
 * else; nothing here stores, returns or logs it, and every message that may reach a log, the database
 * or the renderer goes through redact() against the keys of both providers.
 */
import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { CloudAnswersUnavailable, loadUndecided, SorterStore, type CloudAnswerRow, type CloudPending, type CloudScope } from '../store'
import { checkThresholds, DEFAULT_THRESHOLDS, SORTER_VERSION, type Thresholds } from '../decide'
import { applyCloud, type CascadeRow } from './cascade'
import { LunaResponseError, REASON_MAX, planChunks, selectForCloud, type CloudCandidate, type CostEstimate, type LunaItem } from './luna'
import { clipRedacted, LunaHttpError, pool, postCloud, redact, type HttpPost } from './client'
import type { LunaAnswer, LunaRequest } from './luna'
import { DEFAULT_PROVIDER, isProviderId, otherProviders, PROVIDER_IDS, providerOf, PROVIDERS, type CloudProvider, type ProviderId } from './provider'
import { applySettingsPatch, isSwitch, optedIn, removeKey, serviceOn, storedProvider, storedSwitch, type CloudSettings, type StoredCloudSettings, type StoredKeys } from './settings'
import { readVerified, type VerifyRefusal } from './images'
import { effectiveAnchor, isBatchDue, nextRunAt, nightOf } from './schedule'
import { EVERYTHING, inWindow, isEverything, isSortPeriod, PERIOD_CHOICES, PERIOD_UNREADABLE, periodLabel, periodNote, periodPhrase, periodPrefix, periodWindow, storedPeriod, type PeriodWindow, type SortPeriod } from '../period'

/** Screenshots sent to a cloud model per night window: nightly and Sort now together, both providers together. Fixed; not a setting. */
export const NIGHTLY_LIMIT = 300
/** How long a prepared Sort now batch can be sent. */
export const PREPARED_TTL_MS = 10 * 60 * 1000

export { agreedAt, applySettingsPatch, isSwitch, KEY_FIELD, normaliseCloudSettings, optedIn, removeKey, serviceOn, storedProvider, storedSwitch, withdrawAgreement, type CloudSettings, type StoredCloudSettings, type StoredKeys } from './settings'

export type CloudSkip = 'unavailable' | 'off' | 'nightly-off' | 'rules-changed' | 'no-key' | 'revoked' | 'provider-changed' | 'offline' | 'nothing-doubtful' | 'key-rejected' | 'cancelled' | 'limit-reached' | 'not-prepared' | 'not-confirmed' | 'period-changed' | 'batch-changed' | 'date-changed'

/**
 * What main's native confirm dialog shows (index.ts raises it with dialog.showMessageBox on the main
 * window). `provider` is the one the dialog names and the only one a confirmation counts for.
 * `period` is the period a send is limited to and states in words (absent on turning on, which is
 * about the nightly batch: everything).
 */
export type ConsentPrompt = { kind: 'turn-on' | 'send'; provider: ProviderId; period?: SortPeriod; count: number; /** How many of those the dialog counts the other provider answered and was unsure about. */ secondOpinions: number; estimate: CostEstimate; message: string; detail: string; confirmLabel: string }

export type CloudRunSummary = {
  at: string
  trigger: 'nightly' | 'manual'
  /** The provider this run asked or would have asked (absent in a summary stored before there were two: OpenAI). */
  provider?: ProviderId
  /** The period a manual run was limited to (absent for the nightly batch and in older summaries: everything). */
  period?: SortPeriod
  /** The local step of this run (null when a manual send only ran the cloud step). */
  local: { ok: boolean; message: string } | null
  asked: number
  answered: number
  keep: number
  throwaway: number
  stayedDoubtful: number
  /** The run as three numbers: screenshots sent, those the provider settled (keep or throwaway), and those sent that it left unsure. */
  sent: number
  settled: number
  stillUnsure: number
  skipped: CloudSkip | null
  error: string | null
  message: string
}

/** The three numbers of a run, from its counts. */
const numbersOf = (s: { asked: number; keep: number; throwaway: number }): Pick<CloudRunSummary, 'sent' | 'settled' | 'stillUnsure'> => ({ sent: s.asked, settled: s.keep + s.throwaway, stillUnsure: Math.max(0, s.asked - s.keep - s.throwaway) })
const count = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0)

/** A stored summary with its three numbers; one stored before they were kept gets them from its counts. Null when what is stored is not a summary. */
export function withNumbers(raw: unknown): CloudRunSummary | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as CloudRunSummary
  if (typeof s.at !== 'string' || typeof s.message !== 'string') return null
  return { ...s, ...numbersOf({ asked: count(s.asked), keep: count(s.keep), throwaway: count(s.throwaway) }) }
}

export type CloudPreview = {
  local: { ok: boolean; message: string }
  /** The provider this batch was prepared for; send(token) refuses when another is selected by then. */
  provider: ProviderId
  /** The period this batch was prepared for (null: the stored one could not be read, and nothing was prepared). send(token) refuses when another is selected by then. */
  period: SortPeriod | null
  /** The period as the choice shows it ('Last 30 days'), before a count ('Last 30 days: '; '' for everything), and as a sentence on what it leaves out. */
  periodLabel: string
  periodPrefix: string
  periodNote: string
  /** Doubtful screenshots in the period this provider may be asked about: unanswered ones and the other provider's unsure ones. */
  doubtful: number
  /** How many a send would ask about (doubtful, within what is left tonight). */
  toSend: number
  /** How many of `toSend` the other provider answered and was unsure about. The estimate covers all of `toSend`. */
  secondOpinions: number
  /** Those in words, for the sentence that gives the count ('5 of them ones Luna was unsure about'); '' when none. */
  secondNote: string
  /** The per-night limit. */
  cap: number
  /** What is left of tonight's limit. */
  leftTonight: number
  estimate: CostEstimate
  /** The words before the cost figure and a sentence after it ('' when none), for the provider. */
  costLabel: string
  costNote: string
  /** Why nothing can be sent now; null when send(token) may go ahead. */
  blocked: 'unavailable' | 'off' | 'no-key' | 'offline' | 'busy' | 'nothing-doubtful' | 'limit-reached' | 'period' | null
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
  /** What is left of tonight's limit, nightly and Sort now together; null when the count could not be read. */
  leftTonight: number | null
  lastRun: CloudRunSummary | null
  /** When the nightly batch runs next; null while the cloud step or the nightly switch is off. */
  nextRunAt: string | null
  /** The selected provider's model, short name and company. */
  model: string
  name: string
  company: string
  longEdge: number
  /** Both providers, for the choice and the two key rows in Settings. `agreedAt`: when he agreed to that provider; null when he has not. */
  providers: Array<{ id: ProviderId; name: string; company: string; model: string; hasKey: boolean; agreedAt: string | null }>
  /** The period Sort now is limited to (the same setting as the local sorter's button); null when the stored one cannot be read. */
  period: SortPeriod | null
  periods: ReadonlyArray<{ id: SortPeriod; label: string }>
}

export type CloudState = { lastRunAt: string | null; since: string | null; lastRun: CloudRunSummary | null }

/** One provider's key as the service may use it (an ApiKeyStore is one). */
export type KeyAccess = { get(): string | null; has(): boolean; encryptionAvailable(): boolean }

export type CloudDeps = {
  wellRoot: () => string
  /** The local sorter (sorter/service.ts sortUndecided), on the screenshots inside the window only. `trigger` is for its run record. */
  sortLocal: (window: PeriodWindow, trigger: 'manual' | 'nightly') => Promise<{ ok: boolean; sorted?: number; error?: string }>
  /** The period stored in config, as stored (period.ts storedPeriod reads it). Absent: everything. */
  period?: () => unknown
  /**
   * The local sorter has a current model with enough held-back evidence to sort (whoever starts it).
   * It says nothing about his app rules: that is rulesChangedSinceTest.
   */
  canSortLocal: () => boolean
  /**
   * His app rules are not the ones the local sorter's accuracy report was measured with (sorter/service.ts).
   * While true nothing runs unattended: the nightly batch sorts nothing, claims nothing and sends
   * nothing, and one already running stops before its next request. Sort now is not held back by it.
   */
  rulesChangedSinceTest: () => boolean
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
  /** A clock that only runs forward, in milliseconds from any fixed point: the age of a prepared batch is measured on it. Absent: performance.now(). */
  monotonic?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`
const usd = (x: number): string => (x < 0.01 ? 'under $0.01' : `about $${x.toFixed(2)}`)
/** The plain disclosure in every consent dialog: which company receives what. */
const disclosure = (p: CloudProvider): string =>
  `For each screenshot, ${p.company} (${p.model}) receives the picture, resized to ${p.longEdge} pixels on its long edge, with the app name and window title from its file name. Window titles can name documents, people or folders. The file’s folder and the text read from the picture are not sent.`
const costNote = (p: CloudProvider): string => (p.costNote ? ` ${p.costNote}` : '')
/** Shown when the stored answers cannot be read (store.ts CloudAnswersUnavailable). Nothing is sent then. */
const UNAVAILABLE = 'The answers stored on this Mac could not be read, so nothing can be sent. The stored answers were left as they are.'
/** Shown when a prepared batch is older than PREPARED_TTL_MS, at send() or once main's dialog has returned. */
const TOO_OLD = 'The prepared batch is too old. Press Sort now again to see the current count.'
/** Shown when the second-opinions switch moved between prepare() and the send, or while main's dialog was open. */
const SECOND_CHANGED = 'The second opinions setting was changed, so the count no longer holds. Press Sort now again.'
/** Shown when the cloud step was turned off and on again while main's dialog was open. */
const SERVICE_CHANGED = 'Asking was turned off while the question was open. Press Sort now again.'

/**
 * The second opinions among `count` screenshots, in words: '5 of them ones Luna was unsure about';
 * '' when there are none. `provider` is the one being asked; the words name the other one.
 */
export function secondOpinionNote(count: number, second: number, provider: CloudProvider): string {
  if (second <= 0) return ''
  const who = otherProviders(provider.id).map((p) => p.name).join(' or ')
  if (count === 1) return `one ${who} was unsure about`
  return `${second.toLocaleString('en-GB')} of them ${second === 1 ? 'one' : 'ones'} ${who} was unsure about`
}
const andSecond = (count: number, second: number, provider: CloudProvider): string => {
  const note = secondOpinionNote(count, second, provider)
  return note ? `, ${note}` : ''
}

/**
 * The dialog for turning the cloud step on for a provider: what is waiting now and what a night can
 * cost. `insteadOf` is the provider being asked until now, when this is a change of provider while
 * the cloud step is on. `secondOpinions` is how many of those waiting the other provider answered
 * and was unsure about.
 */
export function turnOnPrompt(waiting: number, leftTonight: number, provider: CloudProvider = PROVIDERS[DEFAULT_PROVIDER], insteadOf: CloudProvider | null = null, secondOpinions = 0): ConsentPrompt {
  const now = Math.min(waiting, leftTonight)
  const estimate = provider.estimateCost(now)
  const change = insteadOf ? `Until now ${insteadOf.company}’s ${insteadOf.name} was asked. From now on the screenshots go to ${provider.company} instead; this is a separate agreement.\n\n` : ''
  return {
    kind: 'turn-on',
    provider: provider.id,
    count: now,
    secondOpinions,
    estimate,
    message: insteadOf ? `Ask ${provider.name} instead of ${insteadOf.name}?` : `Turn on asking ${provider.name}?`,
    detail: `${change}${plural(waiting, 'doubtful screenshot')} ${waiting === 1 ? 'is' : 'are'} waiting now${andSecond(waiting, secondOpinions, provider)}; ${plural(now, 'screenshot')} would go at the next sort. ${provider.costLabel}: ${usd(estimate.usd)}. At most ${NIGHTLY_LIMIT.toLocaleString('en-GB')} screenshots a night (${usd(provider.estimateCost(NIGHTLY_LIMIT).usd)}).${costNote(provider)}\n\n${disclosure(provider)}`,
    confirmLabel: insteadOf ? `Ask ${provider.name}` : 'Turn on'
  }
}

/**
 * The dialog before a Sort now send: this batch's count and estimated cost, and the company it goes
 * to. `secondOpinions` is how many of `count` the other provider answered and was unsure about; the
 * estimate is for all of `count`. `period` is the period the batch is limited to; `count` is the
 * count for that period, and the dialog says so in words.
 */
export function sendPrompt(count: number, provider: CloudProvider = PROVIDERS[DEFAULT_PROVIDER], secondOpinions = 0, period: SortPeriod = 'all'): ConsentPrompt {
  const estimate = provider.estimateCost(count)
  return {
    kind: 'send',
    provider: provider.id,
    period,
    count,
    secondOpinions,
    estimate,
    message: `Send ${plural(count, 'screenshot')}${periodPhrase(period)} to ${provider.name}?`,
    detail: `${periodPrefix(period)}${plural(count, 'screenshot')} the sorter could not call${secondOpinions > 0 ? `${andSecond(count, secondOpinions, provider)},` : ''} will go to ${provider.company} in ${plural(estimate.requests, 'request')}. ${provider.costLabel}: ${usd(estimate.usd)}.${costNote(provider)}\n\n${periodNote(period)}\n\n${disclosure(provider)}`,
    confirmLabel: `Send ${count.toLocaleString('en-GB')}`
  }
}

/**
 * What counts for a provider's run: its own answers (under its model + prompt), the other provider's
 * (under its own), and the confidence from which a throwaway answer is a decision.
 */
function scopeOf(p: CloudProvider, t: Thresholds, secondOpinions: boolean): CloudScope {
  return {
    secondOpinions,
    sorterVersion: SORTER_VERSION,
    provider: p.id,
    model: p.model,
    promptVersion: p.promptVersion,
    others: otherProviders(p.id).map((o) => ({ provider: o.id, model: o.model, promptVersion: o.promptVersion })),
    throwawayAt: checkThresholds(t).throwaway
  }
}

/** Why a run stops before its next request. */
type Revoked = 'off' | 'nightly-off' | 'rules-changed' | 'no-key' | 'revoked' | 'provider-changed'

export class CloudSorter {
  private phase: CloudStatus['phase'] = 'idle'
  private done = 0
  private total = 0
  private abort: AbortController | null = null
  /** The running batch: the provider it is bound to and how to stop it at once (key or provider changed); null when idle. */
  private running: { provider: ProviderId; revoke: (why: Revoked) => void } | null = null
  /** The batch prepare() showed him, bound to the provider and the period window it was prepared for. */
  private prepared: { token: string; hashes: string[]; expiresAt: number; madeAt: number; provider: ProviderId; window: PeriodWindow; secondOpinions: boolean } | null = null
  /**
   * Counts every provider change and, per provider, every key change signalled from Settings. A send
   * waiting on main's dialog has used up `prepared` and is not yet `running`, so neither can stop it;
   * it compares these counts across the dialog instead and sends nothing when one has moved, even if
   * the provider selected and the key stored are by then the same as before.
   */
  private providerChanges = 0
  /** Counts every change of period signalled from Settings, for the same reason: a prepare or a send that began under one period ends with nothing when it has moved. */
  private periodChanges = 0
  private keyChanges: Record<ProviderId, number> = { openai: 0, anthropic: 0 }
  /** Counts every time the cloud step was turned on or off, and every change of the second-opinions switch, for the same reason. */
  private serviceChanges = 0
  private secondOpinionChanges = 0

  constructor(private deps: CloudDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date()
  }

  /** Milliseconds on a clock that cannot be set (deps.monotonic, else this process's own). */
  private monotonic(): number {
    return this.deps.monotonic ? this.deps.monotonic() : performance.now()
  }

  /**
   * Whether a prepared batch can no longer be sent: PREPARED_TTL_MS have passed on the monotonic
   * clock since it was made (`madeAt`), or the wall clock is past `expiresAt` (the monotonic clock
   * may stand still while the Mac sleeps). A wall clock set back does not make it younger. A
   * monotonic reading that is not a number, or is earlier than `madeAt`, counts as too old.
   */
  private tooOld(p: { expiresAt: number; madeAt: number }): boolean {
    const age = this.monotonic() - p.madeAt
    return !(age >= 0 && age <= PREPARED_TTL_MS) || this.now().getTime() > p.expiresAt
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

  private thresholds(): Thresholds {
    return this.deps.thresholds ?? DEFAULT_THRESHOLDS
  }

  /** The period chosen in Settings, read from main's state; null when what is stored is not a period. */
  private period(): SortPeriod | null {
    try {
      return storedPeriod(this.deps.period ? this.deps.period() : undefined)
    } catch {
      return null
    }
  }

  /** Whether second opinions may be asked for now, read from main's state; anything but a stored true is no. */
  private secondOpinions(): boolean {
    try {
      return this.deps.settings().secondOpinions === true
    } catch {
      return false
    }
  }

  /** What counts for a provider's run now. Read again wherever it is used, so a change of the second-opinions switch holds from the next read. */
  private scope(provider: CloudProvider): CloudScope {
    return scopeOf(provider, this.thresholds(), this.secondOpinions())
  }

  /** What is left of tonight's limit; null when the count cannot be read. */
  private leftTonight(): number | null {
    try {
      return Math.max(0, NIGHTLY_LIMIT - this.withStore((s) => s.allowanceUsed(nightOf(this.now()))))
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
    const provider = providerOf(settings.provider)
    const st = this.deps.state()
    return {
      phase: this.phase,
      done: this.done,
      total: this.total,
      hasKey: this.deps.keys[provider.id].has(),
      encryptionAvailable: this.deps.keys[provider.id].encryptionAvailable(),
      settings,
      nightlyLimit: NIGHTLY_LIMIT,
      leftTonight: this.leftTonight(),
      lastRun: withNumbers(this.deps.state().lastRun),
      // from the same anchor tick() goes by (schedule.ts effectiveAnchor), so this is what the scheduler does
      nextRunAt: nextRunAt({ now: this.now(), enabled: settings.enabled === true && settings.nightly === true, batchTime: settings.batchTime, lastRunAt: st.lastRunAt, since: st.since })?.toISOString() ?? null,
      model: provider.model,
      name: provider.name,
      company: provider.company,
      longEdge: provider.longEdge,
      providers: PROVIDER_IDS.map((id) => ({ id, name: PROVIDERS[id].name, company: PROVIDERS[id].company, model: PROVIDERS[id].model, hasKey: this.deps.keys[id].has(), agreedAt: settings.agreedAt?.[id] ?? null })),
      period: this.period(),
      periods: PERIOD_CHOICES
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
   * A provider's key was removed or a key was saved for it (Settings). A prepared batch can no longer
   * be sent: its count was confirmed for the keys as they were. A run is bound to the key it started
   * with, so a running batch that asks that provider stops at once: no further request or retry, its
   * claims released. A change to the other provider's key does not concern the run.
   */
  keyChanged(provider: ProviderId, change: 'cleared' | 'saved'): void {
    this.keyChanges[provider]++
    this.prepared = null
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
   * The cloud step was turned on or off in Settings. A prepared batch can no longer be sent, a send
   * waiting on main's dialog sends nothing, and when it is off now a running batch stops at once.
   */
  serviceChanged(): void {
    this.serviceChanges++
    this.prepared = null
    let on = false
    try {
      on = this.deps.settings().enabled === true
    } catch {
      on = false
    }
    if (!this.running || on) return
    this.log('asking was turned off: stopping the run')
    this.running.revoke('off')
  }

  /**
   * The cloud step or the nightly switch is being turned on. The schedule starts again from now
   * (`since`, which schedule.ts effectiveAnchor honours when it is later than the last run), so a slot
   * that passed while it was off is not caught up: the next nightly batch is the one status() gives
   * as nextRunAt. A service that was on all along is not touched, and still catches up at launch.
   */
  restartSchedule(): void {
    this.deps.saveState({ since: this.now().toISOString() })
  }

  /**
   * The second-opinions switch was changed in Settings. A batch prepared under the earlier position
   * can no longer be sent, and a send waiting on main's dialog sends nothing. A running batch is not
   * stopped: each of its requests reads the switch again as it is admitted (store.ts eligibleSql),
   * so with the switch off no further second opinion goes.
   */
  secondOpinionsChanged(): void {
    this.secondOpinionChanges++
    this.prepared = null
    this.push()
  }

  /**
   * Another period was chosen in Settings. A batch prepared for the earlier one can no longer be sent;
   * a prepare still sorting, or a send waiting on main's dialog, ends with nothing. A batch already
   * confirmed and being sent is left to finish: it is the one he was shown and confirmed.
   */
  periodChanged(): void {
    this.periodChanges++
    this.prepared = null
    this.push()
  }

  /**
   * Turning the cloud step on for a provider (or changing to it while on, `insteadOf` being the one
   * asked until now): main's own dialog with what is waiting, the cost and the company that receives
   * the pictures; true only when he confirms. A confirmation counts for `id` and no other provider.
   */
  async consentToTurnOn(id: ProviderId = this.selected().id, insteadOf: ProviderId | null = null): Promise<boolean> {
    const provider = providerOf(id)
    const found = this.waiting(provider)
    if (!found) {
      // without the stored answers nobody can say what would be sent: it is not turned on
      this.log(`turning on asking ${provider.name}: not possible, the stored answers could not be read`)
      return false
    }
    const waiting = found.list.length
    const leftTonight = Math.max(0, NIGHTLY_LIMIT - this.withStore((s) => s.allowanceUsed(nightOf(this.now()))))
    const ok = await this.deps.confirm(turnOnPrompt(waiting, leftTonight, provider, insteadOf && insteadOf !== id ? providerOf(insteadOf) : null, secondOf(found.list, found.pending))).catch(() => false)
    this.log(`turning on asking ${provider.name}: ${ok ? 'confirmed' : 'not confirmed'}`)
    return ok === true
  }

  /**
   * The selected provider, its opt-in and its key, read again from main's state; the reason to stop
   * when another provider is selected by now, asking was turned off (or, for the nightly batch, the
   * nightly switch was), the key is gone, or it is no longer the key the run started with. Read
   * before every request and every retry.
   */
  private liveConsent(provider: CloudProvider, runKey: string, trigger: CloudRunSummary['trigger']): { ok: true } | { revoked: Revoked } {
    let settings: CloudSettings | null = null
    try {
      settings = this.deps.settings()
    } catch {
      settings = null
    }
    if (!settings) return { revoked: 'off' }
    if (settings.provider !== provider.id) return { revoked: 'provider-changed' }
    if (settings.enabled !== true) return { revoked: 'off' }
    // the nightly batch also needs its own switch; Sort now does not
    if (trigger === 'nightly' && settings.nightly !== true) return { revoked: 'nightly-off' }
    // nor does anything go unattended while his app rules are not the tested ones
    if (trigger === 'nightly' && this.rulesChanged()) return { revoked: 'rules-changed' }
    const key = this.safeKey(provider.id)
    if (!key) return { revoked: 'no-key' }
    return key === runKey ? { ok: true } : { revoked: 'revoked' }
  }

  /**
   * Doubtful screenshots this provider may be asked about (store.ts eligibleSql), with a readable
   * picture on this Mac. `pending` says of each whether it would be a second opinion.
   */
  private candidates(provider: CloudProvider): Candidates {
    const scope = this.scope(provider)
    const pendingRows = this.withStore((s) => s.cloudPending(scope))
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

  /** candidates(), or null when the stored answers cannot be read (store.ts CloudAnswersUnavailable): nothing may be sent then. */
  private waiting(provider: CloudProvider): Candidates | null {
    try {
      return this.candidates(provider)
    } catch (e) {
      if (e instanceof CloudAnswersUnavailable) return null
      throw e
    }
  }

  /** His app rules differ from the tested ones; a reading that fails counts as differing (nothing then runs unattended). */
  private rulesChanged(): boolean {
    try {
      return this.deps.rulesChangedSinceTest() !== false
    } catch {
      return true
    }
  }

  private async runLocal(window: PeriodWindow, trigger: 'manual' | 'nightly' = 'manual'): Promise<{ ok: boolean; message: string }> {
    if (!this.deps.canSortLocal()) return { ok: false, message: 'The sorter on this Mac is not trained enough to sort on its own yet; only screenshots it already found doubtful can be asked about.' }
    this.phase = 'sorting'
    this.push()
    try {
      const r = await this.deps.sortLocal(window, trigger)
      return r.ok ? { ok: true, message: `Sorted ${plural(r.sorted ?? 0, 'screenshot')}${periodPhrase(window.period)} on this Mac.` } : { ok: false, message: r.error ?? 'The sorter on this Mac stopped.' }
    } catch (e) {
      return { ok: false, message: (e as Error)?.message ?? 'The sorter on this Mac stopped.' }
    }
  }

  /**
   * Sort now, step 1: the local sorter on the period chosen in Settings, then the batch a send would
   * ask about (doubtful screenshots in that period only) and its cost. Sends nothing. The period is
   * the stored one and the cut-off is worked out here; there is no argument to widen either.
   */
  async prepare(): Promise<CloudPreview> {
    this.prepared = null
    const first = this.selected()
    const periodChanges = this.periodChanges
    const period = this.period()
    const window = period ? periodWindow(period, this.now()) : null
    const inWords = (p: SortPeriod | null): Pick<CloudPreview, 'period' | 'periodLabel' | 'periodPrefix' | 'periodNote'> => (p ? { period: p, periodLabel: periodLabel(p), periodPrefix: periodPrefix(p), periodNote: periodNote(p) } : { period: null, periodLabel: '', periodPrefix: '', periodNote: '' })
    const none = (patch: Partial<CloudPreview>): CloudPreview => ({ local: { ok: false, message: '' }, provider: first.id, ...inWords(period), doubtful: 0, toSend: 0, secondOpinions: 0, secondNote: '', cap: NIGHTLY_LIMIT, leftTonight: 0, estimate: first.estimateCost(0), costLabel: first.costLabel, costNote: first.costNote, blocked: null, token: null, message: '', ...patch })
    if (this.busy()) return none({ blocked: 'busy', message: 'The sorter is already running.' })
    // a stored period that is not one of the four is not everything: nothing is sorted and nothing prepared
    if (!window) return none({ blocked: 'period', message: PERIOD_UNREADABLE })
    let local: { ok: boolean; message: string }
    try {
      local = await this.runLocal(window)
    } finally {
      this.phase = 'idle'
      this.push()
    }
    // the period was changed while the local sorter ran: what it sorted is not what is selected now
    if (this.periodChanges !== periodChanges || this.period() !== window.period) return none({ local, blocked: 'period', message: 'The period was changed while sorting, so nothing was prepared. Press Sort now again.' })
    const words = periodPhrase(window.period)
    // read after the local sort: the batch is prepared for the provider selected now
    const settings = this.deps.settings()
    const provider = providerOf(settings.provider)
    const { name, company } = provider
    const found = this.waiting(provider)
    if (!found) return none({ local, provider: provider.id, estimate: provider.estimateCost(0), costLabel: provider.costLabel, costNote: provider.costNote, blocked: 'unavailable', message: UNAVAILABLE })
    // only what was taken inside the period is counted, shown or prepared
    const list = within(found.list, window)
    const leftTonight = Math.max(0, NIGHTLY_LIMIT - this.withStore((s) => s.allowanceUsed(nightOf(this.now()))))
    const batch = selectForCloud(list, leftTonight)
    const toSend = batch.length
    const secondOpinions = secondOf(batch, found.pending)
    const secondNote = secondOpinionNote(toSend, secondOpinions, provider)
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
    const waiting = `${plural(list.length, 'screenshot')}${words}`
    const prefix = periodPrefix(window.period)
    const message =
      blocked === 'nothing-doubtful'
        ? `Nothing doubtful${words} is waiting for ${name}.`
        : blocked === 'off'
          ? `${waiting} stay in Review: asking ${name} is turned off.`
          : blocked === 'no-key'
            ? `${waiting} stay in Review: no ${company} key is saved.`
            : blocked === 'offline'
              ? `${waiting} stay in Review: this Mac is offline.`
              : blocked === 'limit-reached'
                ? `${waiting} stay in Review: ${NIGHTLY_LIMIT.toLocaleString('en-GB')} screenshots have been sent tonight, the most per night.`
                : `${prefix ? `${prefix}ask` : 'Ask'} ${name} about ${plural(toSend, 'screenshot')}${toSend < list.length ? ` of ${list.length.toLocaleString('en-GB')} (${leftTonight.toLocaleString('en-GB')} left of tonight’s ${NIGHTLY_LIMIT.toLocaleString('en-GB')})` : ''}${secondNote ? `, ${secondNote}` : ''}?`
    let token: string | null = null
    if (!blocked) {
      token = randomUUID()
      this.prepared = { token, hashes: batch.map((c) => c.hash), expiresAt: this.now().getTime() + PREPARED_TTL_MS, madeAt: this.monotonic(), provider: provider.id, window, secondOpinions: settings.secondOpinions === true }
    }
    return { local, provider: provider.id, ...inWords(window.period), doubtful: list.length, toSend, secondOpinions, secondNote, cap: NIGHTLY_LIMIT, leftTonight, estimate: provider.estimateCost(toSend), costLabel: provider.costLabel, costNote: provider.costNote, blocked, token, message }
  }

  /**
   * Sort now, step 2 (after his click): send the batch prepare() showed him. Refused without the
   * token of the batch prepared last, once it is PREPARED_TTL_MS old (tooOld; checked here and again
   * after main's dialog), or when the provider or the period selected now is not the one the batch
   * was prepared for; a token is used once. The batch goes under the window it was prepared with:
   * nothing outside that period, whatever is selected.
   */
  async send(token: unknown): Promise<CloudRunSummary> {
    const p = this.prepared
    let summary: CloudRunSummary
    if (!p || typeof token !== 'string' || token !== p.token) {
      summary = this.refused('manual', 'This send was not prepared here. Press Sort now and confirm the count first.', this.selected().id)
    } else {
      this.prepared = null
      summary =
        this.tooOld(p)
          ? this.refused('manual', TOO_OLD, p.provider)
          : this.selected().id !== p.provider
            ? this.refused('manual', `The batch was prepared for ${PROVIDERS[p.provider].name}, and another provider is selected now. Press Sort now again.`, this.selected().id)
            : this.period() !== p.window.period
              ? this.refused('manual', `The batch was prepared for ${periodLabel(p.window.period).toLowerCase()}, and another period is selected now. Press Sort now again.`, p.provider)
              : this.secondOpinions() !== p.secondOpinions
                ? this.refused('manual', SECOND_CHANGED, p.provider)
                : await this.runCloud({ trigger: 'manual', local: null, provider: p.provider, only: p.hashes, confirm: true, window: p.window, expired: () => this.tooOld(p) })
    }
    this.deps.saveState({ lastRun: summary })
    this.push()
    return summary
  }

  private refused(trigger: CloudRunSummary['trigger'], error: string, provider: ProviderId): CloudRunSummary {
    this.log(`${trigger} send refused: not prepared`)
    const s: CloudRunSummary = { at: this.now().toISOString(), trigger, provider, local: null, asked: 0, answered: 0, keep: 0, throwaway: 0, stayedDoubtful: 0, sent: 0, settled: 0, stillUnsure: 0, skipped: 'not-prepared', error, message: '' }
    s.message = describe(s)
    return s
  }

  /**
   * The nightly batch: local sorter, then the selected provider's model for what it left doubtful
   * (within tonight's limit). It ignores the period chosen in Settings: both steps take everything.
   * It runs only while the cloud step and the nightly switch are both on, and his app rules are the
   * ones the local sorter was tested with (deps.rulesChangedSinceTest): otherwise it does nothing.
   */
  async runNightly(): Promise<CloudRunSummary> {
    // the nightly switch is off: nothing is sorted, nothing is asked and nothing is recorded
    if (this.deps.settings().nightly !== true) {
      const s: CloudRunSummary = { at: this.now().toISOString(), trigger: 'nightly', provider: this.selected().id, local: null, asked: 0, answered: 0, keep: 0, throwaway: 0, stayedDoubtful: 0, sent: 0, settled: 0, stillUnsure: 0, skipped: 'nightly-off', error: null, message: '' }
      s.message = describe(s)
      return s
    }
    this.deps.saveState({ lastRunAt: this.now().toISOString() }) // first, so a crash mid-run is not retried every minute
    // his app rules are not the ones the sorter was tested with: nothing is sorted, claimed or sent
    // unattended. The night is recorded as skipped, so the tab can say why, and tried again tomorrow.
    if (this.rulesChanged()) {
      const s: CloudRunSummary = { at: this.now().toISOString(), trigger: 'nightly', provider: this.selected().id, local: null, asked: 0, answered: 0, keep: 0, throwaway: 0, stayedDoubtful: 0, sent: 0, settled: 0, stillUnsure: 0, skipped: 'rules-changed', error: null, message: '' }
      s.message = describe(s)
      this.log('nightly run skipped: the app rules changed since the sorter was last tested')
      this.deps.saveState({ lastRun: s })
      this.push()
      return s
    }
    let local: { ok: boolean; message: string }
    try {
      local = await this.runLocal(EVERYTHING, 'nightly')
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
    const now = this.now()
    const s = this.deps.settings()
    // decided on the stored times as they are, before `since` is written below
    const due = isBatchDue({ now, enabled: s.enabled === true && s.nightly === true, batchTime: s.batchTime, lastRunAt: st.lastRunAt, since: st.since })
    const { sinceMissing, rewriteSince } = effectiveAnchor({ now, lastRunAt: st.lastRunAt, since: st.since })
    if (rewriteSince) {
      // not a time, or later than the clock: it counted as now (nothing is caught up) and is stored as now
      this.log('the stored schedule start was not a past time: the schedule starts again from now')
      this.deps.saveState({ since: now.toISOString() })
      return null
    }
    if (sinceMissing) {
      // a fresh install has no last run, so nothing is due. A config from before `since` existed, on
      // all along, keeps its one catch-up from the last run: `since` is stored only once that batch can
      // start (while the sorter is busy it stays missing, and the next check comes back here)
      if (due && this.busy()) return null
      this.deps.saveState({ since: now.toISOString() })
    }
    if (!due || this.busy()) return null
    this.log('nightly batch due')
    return this.runNightly()
  }

  /**
   * One run, bound from here on to `o.provider` and to that provider's key as read below: every
   * request goes to that provider's endpoint with that key, or is not made. `o.window` is the period
   * window a manual batch was prepared with: nothing outside it is claimed, counted or sent, and each
   * request checks the dates again as it is admitted. Without one (the nightly batch) the run takes
   * everything. `o.expired` says whether the prepared batch has grown too old; it is asked once
   * main's dialog has returned.
   */
  private async runCloud(o: { trigger: CloudRunSummary['trigger']; local: CloudRunSummary['local']; provider: ProviderId; only?: string[]; confirm?: boolean; window?: PeriodWindow; expired?: () => boolean }): Promise<CloudRunSummary> {
    const { trigger, local } = o
    const window = o.window ?? EVERYTHING
    const provider = providerOf(o.provider)
    const at = this.now().toISOString()
    const base: CloudRunSummary = { at, trigger, provider: provider.id, ...(o.window ? { period: window.period } : {}), local, asked: 0, answered: 0, keep: 0, throwaway: 0, stayedDoubtful: 0, sent: 0, settled: 0, stillUnsure: 0, skipped: null, error: null, message: '' }
    const finish = (patch: Partial<CloudRunSummary>): CloudRunSummary => {
      const s = { ...base, ...patch }
      Object.assign(s, numbersOf(s))
      s.message = describe(s)
      this.log(`${trigger} run (${provider.name}): asked ${s.asked}, answered ${s.answered} (keep ${s.keep}, throwaway ${s.throwaway}, still doubtful ${s.stayedDoubtful})${s.skipped ? `, skipped: ${s.skipped}` : ''}${s.error ? `, error: ${s.error}` : ''}`)
      return s
    }
    if (this.busy()) return finish({ error: 'The sorter is already running.' })
    const found = this.waiting(provider)
    // the nightly rules gate, read again straight after the local step (a rule may have changed while it
    // ran) and before any return that depends on what is waiting: that outcome is the one recorded
    if (trigger === 'nightly' && this.rulesChanged()) return finish({ skipped: 'rules-changed', stayedDoubtful: found?.list.length ?? 0 })
    if (!found) return finish({ skipped: 'unavailable' })
    const { list, pending } = found
    // `list` stays everything doubtful (the summary says how many still need a look); the run draws only on the period
    let pool0 = within(list, window)
    if (o.only) {
      const byHash = new Map(pool0.map((c) => [c.hash, c]))
      pool0 = o.only.map((h) => byHash.get(h)).filter((c): c is CloudCandidate => Boolean(c))
    }
    if (!pool0.length) return finish({ skipped: 'nothing-doubtful', stayedDoubtful: list.length })
    // the opt-in read here is the selected provider's; a run for any other provider does not start
    const settings = this.deps.settings()
    if (settings.provider !== provider.id) return finish({ skipped: 'provider-changed', stayedDoubtful: list.length })
    if (settings.enabled !== true) return finish({ skipped: 'off', stayedDoubtful: list.length })
    if (trigger === 'nightly' && settings.nightly !== true) return finish({ skipped: 'nightly-off', stayedDoubtful: list.length })
    const key = this.deps.keys[provider.id].get()
    // a key that is not this provider's kind is no key: it is never put into a request to this provider
    if (!key || provider.keyRule(key) !== null) return finish({ skipped: 'no-key', stayedDoubtful: list.length })
    if (!this.deps.online()) return finish({ skipped: 'offline', stayedDoubtful: list.length })
    let wanted = selectForCloud(pool0, NIGHTLY_LIMIT)
    if (!wanted.length) return finish({ skipped: 'nothing-doubtful', stayedDoubtful: list.length })
    if (o.confirm) {
      // a manual send goes only after main's own dialog, which names this provider, returns OK
      const providerChanges = this.providerChanges
      const periodChanges = this.periodChanges
      const keyChanges = this.keyChanges[provider.id]
      const serviceChanges = this.serviceChanges
      const secondOpinionChanges = this.secondOpinionChanges
      const counted = { count: wanted.length, second: secondOf(wanted, pending) }
      const ok = await this.deps.confirm(sendPrompt(counted.count, provider, counted.second, window.period)).catch(() => false)
      if (ok !== true) return finish({ skipped: 'not-confirmed', stayedDoubtful: list.length })
      if (this.busy()) return finish({ error: 'The sorter is already running.' })
      // the dialog may have stood open past the batch's ten minutes: then it is as if it had never been prepared
      if (o.expired?.()) return finish({ skipped: 'not-prepared', error: TOO_OLD, stayedDoubtful: list.length })
      // nor does it count for another period: the dialog gave the count for the one it named
      if (this.periodChanges !== periodChanges || this.period() !== window.period) return finish({ skipped: 'period-changed', stayedDoubtful: list.length })
      // the dialog may have stood open a while: the confirmation counts only for the provider it named
      // and only if no other provider was selected meanwhile, even one switched away from and back to
      if (this.providerChanges !== providerChanges) return finish({ skipped: 'provider-changed', stayedDoubtful: list.length })
      const live = this.liveConsent(provider, key, trigger)
      if (!('ok' in live)) return finish({ skipped: live.revoked, stayedDoubtful: list.length })
      // nor if the cloud step was turned off meanwhile, even when it is on again by now
      if (this.serviceChanges !== serviceChanges) return finish({ skipped: 'not-prepared', error: SERVICE_CHANGED, stayedDoubtful: list.length })
      // nor if the second-opinions switch was changed: the dialog counted the batch under the earlier position
      if (this.secondOpinionChanges !== secondOpinionChanges) return finish({ skipped: 'not-prepared', error: SECOND_CHANGED, stayedDoubtful: list.length })
      // nor if this provider's key was removed or saved meanwhile, even when the same key is stored again
      if (this.keyChanges[provider.id] !== keyChanges) return finish({ skipped: 'revoked', stayedDoubtful: list.length })
      // the dialog gave a count: what goes is exactly that batch or nothing. If any of it is by now
      // decided, answered or dated outside the window, nothing is sent and he is asked to start again
      const after = this.waiting(provider)
      if (!after) return finish({ skipped: 'unavailable' })
      const still = new Set(within(after.list, window).map((c) => c.hash))
      const left = wanted.filter((c) => still.has(c.hash))
      if (left.length !== counted.count || secondOf(left, after.pending) !== counted.second) return finish({ skipped: 'batch-changed', stayedDoubtful: after.list.length })
    }

    // claim the batch in one transaction: tonight's limit and other runs (other processes too) are checked there
    const night = nightOf(this.now())
    const runId = randomUUID()
    const { claimed, leftBefore } = this.withStore((s) => s.claimForCloud(wanted.map((c) => c.hash), { ...this.scope(provider), night, limit: NIGHTLY_LIMIT, runId, now: this.now() }))
    if (!claimed.length) return finish({ skipped: leftBefore === 0 ? 'limit-reached' : 'nothing-doubtful', stayedDoubtful: list.length })
    // From here the run holds claims. Everything else it does (setup and the first status broadcast
    // included) runs inside `rest`, under the cleanup below: whatever is thrown or returned, the
    // runtime state goes back to idle and this run's claims are released.
    const rest = async (): Promise<CloudRunSummary> => {
      // main's dialog gave a count: a manual send is that many or none. Fewer were claimed (tonight's
      // allowance shrank, or another run holds some): the claims go and he is asked to start again.
      // The nightly batch has no confirmed count and goes with what fits.
      if (o.confirm && claimed.length !== wanted.length) return finish({ skipped: 'batch-changed', stayedDoubtful: list.length })
      const claimedSet = new Set(claimed)
      const selected = wanted.filter((c) => claimedSet.has(c.hash))

      const t = this.thresholds()
      const ctl = new AbortController()
      this.abort = ctl
      this.phase = 'asking'
      this.done = 0
      this.total = selected.length
      this.push()
      let fatal: LunaHttpError | null = null
      let revoked: Revoked | null = null
      // a capture date left the window after sending began: the run stops, nothing more is sent
      let dateChanged = false
      // the night this run counts against ended (local noon passed): nothing more is admitted
      let nightEnded = false
      // a manual send whose confirmed batch no longer goes whole (store.ts admitForRequest `confirmed`): nothing more is sent
      let batchChanged = false
      const paths = new Map(selected.map((c) => [c.hash, c.path]))
      let chunkError: string | null = null
      const refused = new Map<NotSent, number>()
      const refuse = (why: NotSent, n = 1): void => void refused.set(why, (refused.get(why) ?? 0) + n)
      // revocation: the selected provider, its opt-in and its key from main's state; when the provider
      // is another by now, the opt-in has gone, or the key is no longer the one this run started with,
      // stop the whole run (requests only ever carry `key`, and only ever go to `provider`)
      const consent = (): void => {
        const c = this.liveConsent(provider, key, trigger)
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
      await pool(
        planChunks(selected, provider.chunkSize),
        provider.concurrency,
        async (chunk) => {
          if (ctl.signal.aborted || nightEnded) return
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
              // the run), then eligibility per item (he may have decided or answered one meanwhile, or
              // turned second opinions off: the scope is read again here), the
              // capture dates against the batch's window (a manual run; one outside stops the run), and
              // tonight's allowance, counted here for what goes into the request (store.ts admitForRequest)
              before: (attempt) => {
                consent()
                // the allowance is counted against the night the run began in; past its end (noon) a
                // request would be charged to a night that is over, so none is made, first try or retry.
                // Requests already out finish; the claims not sent go when the run ends
                if (nightEnded || nightOf(this.now()) !== night) {
                  nightEnded = true
                  refuse('night-ended', current.length)
                  current = []
                  last.req = null
                  return 'skip'
                }
                const { admitted, overLimit, outOfPeriod, short } = this.withStore((s) => s.admitForRequest(current.map((i) => i.hash), { ...this.scope(provider), runId, night, limit: NIGHTLY_LIMIT, ...(o.window ? { window, paths } : {}), ...(o.confirm ? { confirmed: wanted.length } : {}) }))
                if (outOfPeriod) {
                  // nothing was admitted or counted for this request; it is not made, and no other starts
                  dateChanged = true
                  refuse('out-of-period', outOfPeriod)
                  ctl.abort()
                  current = []
                  last.req = null
                  return 'skip'
                }
                if (short) {
                  // nothing was admitted or counted for this request and the run's claims went in that
                  // transaction; the request is not made, and no other starts
                  batchChanged = true
                  refuse('batch-changed', current.length)
                  ctl.abort()
                  current = []
                  last.req = null
                  return 'skip'
                }
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
            const said = new Map<string, LunaAnswer>()
            for (const [hash, raw] of parsed.answers) {
              // whatever the model wrote, no key reaches the database or the renderer
              const a = { ...raw, reason: clipRedacted(scrub(raw.reason), REASON_MAX) } // redact first, then shorten
              answers.push({ hash, ...a, provider: provider.id, model: provider.model, promptVersion: provider.promptVersion, askedAt })
              if (pending.has(hash)) said.set(hash, a)
            }
            // each proposal is worked out in the saving transaction from the row as it is then, not from
            // what this batch read before the request went out: a retrain may have re-scored the row
            // meanwhile. The write re-checks eligibility in SQL (store.ts saveCloudResults)
            const proposals = new Map<string, CascadeRow>()
            const written = new Set(
              this.withStore((s) =>
                s.saveCloudResults(answers, {
                  sorterVersion: SORTER_VERSION,
                  hashes: [...said.keys()],
                  combine: (hash, live) => {
                    const row = applyCloud({ proposal: 'doubtful', confidence: live.confidence, pKeep: live.pKeep, reason: live.reason, decidedBy: null }, said.get(hash)!, provider, t)
                    proposals.set(hash, row)
                    return row
                  }
                })
              )
            )
            for (const [hash, pr] of proposals) {
              if (!written.has(hash)) continue
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
        () => ctl.signal.aborted || nightEnded,
        // a worker threw (a status broadcast, a store write): the run is aborted and no chunk starts;
        // pool waits for every request still out before it rethrows, so the cleanup below never
        // releases claims or marks the sorter idle while one of this run's requests is outstanding
        () => ctl.abort()
      )
      for (const [why, n] of refused) this.log(`${n} screenshot(s) not sent: ${REFUSAL_WORDS[why]}`)
      const stayedDoubtful = list.length - counts.keep - counts.throwaway
      const r = revoked as Revoked | null
      if (r) return finish({ ...counts, stayedDoubtful, skipped: r })
      if (dateChanged) return finish({ ...counts, stayedDoubtful, skipped: 'date-changed' })
      if (batchChanged) {
        const s = finish({ ...counts, stayedDoubtful, skipped: 'batch-changed' })
        // earlier requests went before the rest stopped fitting: say how many went and how many did not
        // (the confirmed count is known only here; the summary's numbers already hold what went)
        if (s.asked) s.message = partSent(s.asked, wanted.length, stayedDoubtful)
        return s
      }
      const f = fatal as LunaHttpError | null
      if (f) {
        const skipped: CloudSkip | null = f.kind === 'offline' ? 'offline' : f.kind === 'auth' ? 'key-rejected' : f.kind === 'cancelled' ? 'cancelled' : null
        return finish({ ...counts, stayedDoubtful, skipped, error: skipped === 'offline' || skipped === 'cancelled' ? null : scrub(f.message) })
      }
      if (nightEnded) {
        // no outcome of its own (the outcomes are a type the renderer shares): stopped, with the reason in words
        const s = finish({ ...counts, stayedDoubtful, skipped: 'cancelled' })
        s.message = `Stopped${s.asked ? ` after asking ${provider.name} about ${plural(s.asked, 'screenshot')}` : ''}: the night this run counted against ended at noon. Nothing more was sent.${stayedDoubtful ? ` ${plural(stayedDoubtful, 'screenshot')} still need${stayedDoubtful === 1 ? 's' : ''} a look.` : ''}`
        return s
      }
      return finish({ ...counts, stayedDoubtful, error: chunkError })
    }
    let summary: CloudRunSummary
    let releaseFailed: string | null = null
    try {
      summary = await rest()
    } finally {
      // first, and whatever the release below does: a sorter left busy would refuse every later run
      this.abort = null
      this.running = null
      this.phase = 'idle'
      this.done = 0
      this.total = 0
      try {
        // claims go (unsent ones too); the allowance already holds only what went into a request
        this.withStore((s) => s.releaseClaims(runId))
      } catch (e) {
        releaseFailed = redact(e instanceof Error ? e.message : String(e), key, ...this.safeKeys())
        this.log(`${trigger} run (${provider.name}): its claims could not be released: ${releaseFailed}`)
      }
    }
    if (!releaseFailed) return summary
    // said in the result too: until the claims go stale these screenshots are held back from other runs
    const note = `${RELEASE_FAILED} (${releaseFailed})`
    return { ...summary, error: summary.error ? `${summary.error} ${note}` : note, message: `${summary.message} ${note}` }
  }
}

const REVOKED_WORDS: Record<Revoked, (p: CloudProvider) => string> = {
  off: (p) => `Asking ${p.name} was turned off`,
  'nightly-off': () => 'Nightly sorting was turned off',
  'rules-changed': () => 'The app rules changed since the sorter was last tested',
  'no-key': (p) => `The ${p.company} key was removed`,
  revoked: (p) => `The ${p.company} key was changed`,
  'provider-changed': () => 'Another provider was selected'
}

type Candidates = { list: CloudCandidate[]; pending: Map<string, CloudPending> }
/** Those of the candidates taken inside the period window (period.ts inWindow, by capture time). */
const within = (list: CloudCandidate[], w: PeriodWindow): CloudCandidate[] => (isEverything(w) ? list : list.filter((c) => inWindow(c.takenAt, w)))
/** How many of these the other provider answered and was unsure about. */
const secondOf = (batch: ReadonlyArray<{ hash: string }>, pending: Map<string, CloudPending>): number => batch.filter((c) => pending.get(c.hash)?.secondOpinion).length

type NotSent = VerifyRefusal | 'no-longer-eligible' | 'limit-reached' | 'out-of-period' | 'night-ended' | 'batch-changed'
/** Log words for a screenshot that was not sent (never its path or name). */
const REFUSAL_WORDS: Record<NotSent, string> = {
  'limit-reached': 'tonight’s limit was reached',
  changed: 'the file changed since it was scanned',
  symlink: 'the path is a link, not the file',
  'not-a-file': 'the path is not a regular file',
  'too-large': 'the file is too large',
  unreadable: 'the file could not be read',
  'no-longer-eligible': 'decided or answered meanwhile',
  'out-of-period': 'its date is no longer in the period',
  'night-ended': 'the night the run counted against had ended',
  'batch-changed': 'the confirmed batch could no longer go whole'
}

/** Added to a run's result when its claims could not be released at the end (they go stale after CLAIM_STALE_MS, store.ts). */
export const RELEASE_FAILED = 'The screenshots this run had set aside could not be released; they are held back from other runs for up to six hours.'

/** A manual send that stopped after some of its confirmed batch had gone: tonight's limit no longer had room for the rest. */
export const partSent = (sent: number, confirmed: number, stayedDoubtful: number): string =>
  `Sent ${sent.toLocaleString('en-GB')} of ${confirmed.toLocaleString('en-GB')}. The other ${plural(Math.max(0, confirmed - sent), 'screenshot')} ${confirmed - sent === 1 ? 'was' : 'were'} not sent because tonight’s limit was reached; press Sort now again to prepare them.${stayedDoubtful ? ` ${plural(stayedDoubtful, 'screenshot')} still need${stayedDoubtful === 1 ? 's' : ''} a look.` : ''}`

/** One plain sentence for Settings. */
export function describe(s: CloudRunSummary): string {
  const { name, company } = providerOf(s.provider)
  const waiting = s.stayedDoubtful ? ` ${plural(s.stayedDoubtful, 'screenshot')} still need${s.stayedDoubtful === 1 ? 's' : ''} a look.` : ''
  const words = isSortPeriod(s.period) ? periodPhrase(s.period) : ''
  switch (s.skipped) {
    case 'unavailable':
      return `${name} was not asked. ${UNAVAILABLE}`
    case 'not-prepared':
      return `Nothing was sent. ${s.error ?? ''}`.trim()
    case 'not-confirmed':
      return `Nothing was sent: you did not confirm.${waiting}`
    case 'off':
      return s.asked
        ? `Stopped after asking ${name} about ${plural(s.asked, 'screenshot')}: asking ${name} was turned off.${waiting}`
        : `${name} was not asked: asking ${name} is turned off.${waiting}`
    case 'nightly-off':
      return s.asked ? `Stopped after asking ${name} about ${plural(s.asked, 'screenshot')}: nightly sorting was turned off.${waiting}` : `${name} was not asked: nightly sorting is turned off.${waiting}`
    case 'rules-changed':
      return `${s.asked ? `Stopped after asking ${name} about ${plural(s.asked, 'screenshot')}` : s.local?.ok ? 'Nothing was sent' : 'Nothing was sorted or sent'}: your app rules changed since the sorter was last tested. Train it again and nightly sorting carries on.${waiting}`
    case 'limit-reached':
      return `${name} was not asked: ${NIGHTLY_LIMIT.toLocaleString('en-GB')} screenshots have been sent tonight, the most per night.${waiting}`
    case 'period-changed':
      return `Nothing was sent: the period was changed in Settings. Press Sort now again.${waiting}`
    case 'batch-changed':
      // some went (the run gives the exact sentence, partSent; this is for a summary read without it)
      if (s.asked) return `Stopped after asking ${name} about ${plural(s.asked, 'screenshot')}: tonight’s limit was reached before the rest could go. Press Sort now again.${waiting}`
      return `Nothing was sent: the screenshots changed while the question was open. Press Sort now again.${waiting}`
    case 'date-changed':
      return `Stopped${s.asked ? ` after asking ${name} about ${plural(s.asked, 'screenshot')}` : ''}: a screenshot’s date changed and it is no longer in the period. Nothing more was sent. Press Sort now again.${waiting}`
    case 'nothing-doubtful':
      return `Nothing doubtful${words} was waiting for ${name}.`
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
  return `Asked ${name} about ${plural(s.asked, 'screenshot')}${words}: ${s.keep.toLocaleString('en-GB')} keep, ${s.throwaway.toLocaleString('en-GB')} throwaway.${waiting}`
}

/**
 * A settings change from the renderer. The cloud step is on for a provider only after main's own
 * dialog naming that provider (consentToTurnOn) returns OK. That covers both ways there: turning it
 * on, and selecting another provider while it is on. Declined, the provider stays as it was and the
 * cloud step is not turned on; everything else in the patch (the batch time) still applies. While
 * the cloud step is off, a provider can be selected without a dialog: nothing is sent while it is off,
 * and turning it on afterwards asks for that provider. A provider he has already agreed to is
 * selected, or turned on again after being off, without a second dialog: turning the cloud step off
 * keeps both agreements. Whenever the cloud step ends up on where it was off, or off where it was on,
 * the service is told (serviceChanged). Where it ends up on having been off, the nightly schedule
 * starts again from now, before the change is stored (restartSchedule): a slot that passed while it
 * was off is not caught up.
 */
export async function changeSettings(svc: Pick<CloudSorter, 'consentToTurnOn' | 'providerChanged'> & Partial<Pick<CloudSorter, 'serviceChanged' | 'restartSchedule'>>, patch: unknown, current: () => StoredCloudSettings, save: (s: StoredCloudSettings) => void, now: () => Date): Promise<void> {
  let p: Record<string, unknown> = patch && typeof patch === 'object' ? { ...(patch as Record<string, unknown>) } : {}
  if (!isProviderId(p.provider)) delete p.provider // only the two ids select a provider
  const before = current()
  const from = storedProvider(before)
  const to = isProviderId(p.provider) ? p.provider : from
  const on = serviceOn(before)
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
  if (next.enabled && !serviceOn(latest)) svc.restartSchedule?.() // first: stored on with the old anchor, the next check would catch up
  save(next)
  if (next.provider !== storedProvider(latest)) svc.providerChanged()
  if (next.enabled !== serviceOn(latest)) svc.serviceChanged?.()
}

type SwitchResult = { ok: boolean; error?: string }
/** Shown when a switch is set to anything but on or off. */
export const SWITCH_REFUSED = 'That is neither on nor off, so nothing was changed.'

/**
 * The nightly switch, set from the renderer. Only true or false is stored; anything else is refused
 * and what is stored stays as it was. It turns nothing on by itself: the nightly batch still needs
 * the cloud step on, which needs his agreement. Turned on where it was off, the nightly schedule
 * starts again from now, before the switch is stored (restartSchedule): a slot that passed while it
 * was off is not caught up.
 */
export function changeNightly(value: unknown, save: (s: StoredCloudSettings) => void, current?: () => StoredCloudSettings, svc?: Pick<CloudSorter, 'restartSchedule'>): SwitchResult {
  if (!isSwitch(value)) return { ok: false, error: SWITCH_REFUSED }
  if (value && current && !storedSwitch(current(), 'nightly')) svc?.restartSchedule()
  save({ nightly: value })
  return { ok: true }
}

/**
 * The second-opinions switch, set from the renderer. Only true or false is stored; anything else is
 * refused. A change of position drops the prepared batch (secondOpinionsChanged).
 */
export function changeSecondOpinions(svc: Pick<CloudSorter, 'secondOpinionsChanged'>, value: unknown, current: () => StoredCloudSettings, save: (s: StoredCloudSettings) => void): SwitchResult {
  if (!isSwitch(value)) return { ok: false, error: SWITCH_REFUSED }
  const before = storedSwitch(current(), 'secondOpinions')
  save({ secondOpinions: value })
  if (before !== value) svc.secondOpinionsChanged()
  return { ok: true }
}

/**
 * IPC for Settings › Screenshot sorter › cloud step. Types: src/preload/index.ts. Never returns a key.
 * A key is saved or removed for the provider the call names (one of the two ids, or it is refused):
 * there is no default and no guessing from the key, so a key cannot land in the other provider's store.
 * `saveSettings` merges what it is given into the stored settings (index.ts), in one write of
 * config.json per call. Removing a key is one such call: the ciphertext, his agreement to that
 * provider and the resulting on/off go together (settings.ts removeKey), so no failure between two
 * writes can leave an agreement without its key.
 */
export function registerCloudIpc(
  svc: CloudSorter,
  keys: Record<ProviderId, { set(k: unknown): { ok: boolean; saved: boolean; error?: string } }>,
  saveSettings: (s: StoredCloudSettings & StoredKeys) => void,
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
    // removing a key withdraws his agreement to that provider: a key saved later needs the dialog again.
    // One write for the key, the agreement and on/off; only then is the service told
    const before = current()
    saveSettings(removeKey(before, provider))
    svc.keyChanged(provider, 'cleared')
    if (serviceOn(before) !== serviceOn(current())) svc.serviceChanged()
    return svc.status()
  })
  // only the provider, on/off (his agreement per provider is recorded here with its time after main's own dialog; off keeps it) and the batch time can be set; the limit is fixed
  handle('cloud:set-settings', async (patch: unknown) => {
    await changeSettings(svc, patch, current, saveSettings, () => new Date())
    return svc.status()
  })
  // the two switches take true or false and nothing else; neither turns the cloud step on
  handle('cloud:set-nightly', (value: unknown) => ({ ...changeNightly(value, saveSettings, current, svc), status: svc.status() }))
  handle('cloud:set-second-opinions', (value: unknown) => ({ ...changeSecondOpinions(svc, value, current, saveSettings), status: svc.status() }))
  handle('cloud:prepare', () => svc.prepare())
  handle('cloud:send', (token: unknown) => svc.send(token))
  handle('cloud:cancel', () => svc.cancel())
}
