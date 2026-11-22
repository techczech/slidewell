// Updating in place (ADR-0044 §3, §5): the engine behind the one click, free of Electron so that it is tested in
// Vitest with a fake Squirrel.Mac, and in the packaged fixture with the real electron-updater.
// src/main/update-installer.ts wires it to Electron; src/shared/update-install.ts holds the states and words.
//
// This is TalkWeaver's deferred Squirrel.Mac hand-over. Download and verify without arming ShipIt.
// An explicit restart (the original click when idle, or Restart after a hold) first closes windows
// and waits for writes. While preparation may be armed, only this attempt's native quit is allowed.
import { CancellationToken, Provider, type AppUpdater, type UpdateInfo } from 'electron-updater'
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider'
import { compareVersions } from '@app-patterns/updates'
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { failReasonOf, installStep, IDLE, type FailReason, type InstallEvent, type InstallPhase, type ReopenCause, type RestartBlocker } from '../shared/update-install'

/** Past this, a restart that has not happened is reported (Squirrel.Mac's checks of a large app take a while). */
export const RESTART_WATCHDOG_MS = 5 * 60 * 1000

/** The version offered and its file for this computer, as the validated feed gave them. */
export interface Offer {
  version: string
  released: string
  url: string
  sha512: string
  size: number
  /** CFBundleIdentifier of the installed and offered Mac app. */
  bundleId: string
}

/** Electron's autoUpdater on a Mac (Squirrel.Mac): the part the engine uses (setFeedURL is electron-updater's, at hand-over). */
export interface NativeUpdater {
  on(event: 'update-downloaded' | 'update-not-available' | 'error', listener: (...args: any[]) => void): unknown
  checkForUpdates(): void
  quitAndInstall(): void
}

/** The download half of electron-updater, as the engine asks it (dependencyDownload adapts a real AppUpdater). */
export interface Downloader {
  /** Hands the offer to the updater; resolves whether it is newer than the running version. */
  check(offer: Offer): Promise<boolean>
  /** Downloads and checks the SHA-512; resolves to the downloaded file. Rejects when cancelled. Hands nothing to Squirrel.Mac. */
  retrieve(token: CancellationToken, progress: (received: number, total: number) => void): Promise<string>
}

/** Whether something is there: only a definite answer counts; a check that failed is 'unknown', never 'absent'. */
export type Presence = 'present' | 'absent' | 'unknown'

/** `launchctl list <label>`: 0 means the job is loaded, 113 that launchd has no such service. A timeout, a signal,
 *  a failure to run it, or any other exit code is not an answer. */
export function launchdJobPresence(r: { status: number | null; signal?: string | null; error?: unknown }): Presence {
  if (r.error || r.signal || r.status === null) return 'unknown'
  if (r.status === 0) return 'present'
  if (r.status === 113) return 'absent'
  return 'unknown'
}

/** A path: there if `stat` succeeds, absent only when the file system says it does not exist. */
export function pathPresence(stat: () => unknown): Presence {
  try { stat(); return 'present' } catch (error) {
    const code = (error as { code?: string } | null)?.code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unknown'
  }
}

/** What withdrawNative found and what it then checked. */
export interface Withdrawal {
  /** A ShipIt job or an install request was there before the withdrawal. */
  found: boolean
  /** Checked afterwards, not assumed: no ShipIt job for this app in launchd and no install request on disk. */
  gone: boolean
  /** What the check afterwards found: 'present' only when the ShipIt job AND the install request were both
   *  definitely there; 'absent' only when both were definitely gone; anything else 'unknown'. */
  after: Presence
}

export interface EnginePorts {
  platform: string
  /** Why no update may start now (a Store copy, a development run, a protected task…), or null. Read at the click. */
  gate(offer: Offer): string | null
  /** Everything a restart now would cost the person, read from the main process at the moment of asking. */
  blockers(): RestartBlocker[]
  downloader(): Downloader
  /** Size and version of the downloaded file; null when it is the version offered. */
  verify(file: string, offer: Offer): Promise<FailReason | null>
  /** D3 only: serve the verified file on electron-updater's local address and set Squirrel.Mac's feed to it. */
  handOver(file: string): Promise<void>
  /** Squirrel.Mac, reached only in the native phase of an authorised restart. */
  native(): NativeUpdater
  /** D3's commit: close every window through the app's own close route. True only when every window has closed;
   *  false as soon as one is kept open. */
  closeWindows(): Promise<boolean>
  /** How many windows are open now (every BrowserWindow, hidden ones too). The native install is called only at zero. */
  openWindows(): number
  /** After the windows have closed: waits for every main-process write queue to finish (write-queues.ts). True only
   *  when each finished with nothing failed, in time. */
  drainWriteQueues(): Promise<boolean>
  /** The write queues with work in flight now, read in the turn of the native call (write-queues.ts). */
  writeQueuesBusy(): readonly string[]
  /** The commit began (windows closing) and the restart will not happen: the app gives the person a window back. */
  commitAbandoned?(): void
  /** Removes Squirrel.Mac's ShipIt job and its install request and staged copy, then checks that both are gone. */
  withdrawNative(): Promise<Withdrawal>
  /** Removes the downloaded file and the updater's cache, and closes electron-updater's local address. */
  releaseFiles(): void
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
  now?: () => number
  changed(): void
  log(message: string): void
}

interface Attempt {
  id: number
  offer: Offer
  token: CancellationToken
  /** Cancel, a failure, a leftover or the watchdog ended it: nothing it started may act any more. */
  ended: boolean
  /** Its download chain has finished (resolved or rejected): its files may be removed. */
  settled: boolean
  released: boolean
  /** The verified file (D2 and D3). */
  file: string | null
  /** Squirrel.Mac was asked to prepare it (D3). */
  asked: boolean
  /** Squirrel.Mac answered that question (ready, none or an error). */
  answered: boolean
  /** Squirrel.Mac answered that it is prepared: ShipIt is armed. */
  ready: boolean
  /** The commit has begun: nothing held after the ready answer and the windows are being closed. */
  closing: boolean
  /** quitIfPermitted() called the native install: past the point of no return (unless it fails). */
  quitting: boolean
  watchdog: unknown
}

export function createUpdateEngine(ports: EnginePorts) {
  const timers = ports.timers ?? { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) }
  const now = ports.now ?? Date.now
  let state: InstallPhase = IDLE
  let current: Attempt | null = null
  let seq = 0
  /** The last attempt's download chain; a new attempt waits for it so that two never share electron-updater. */
  let previous: Promise<void> = Promise.resolve()
  /** The attempt whose Squirrel.Mac preparation has not been answered yet (one native question at a time). */
  let nativeOwner: Attempt | null = null
  let nativeHooked = false
  let lastTold = 0
  /**
   * Squirrel.Mac has, or may have, armed ShipIt in this run and the restart did not happen (D4). No native request
   * is made again until SlideWell is reopened (Squirrel.Mac launches ShipIt once per run of the app).
   */
  let spent = false
  /** Withdrawals still being checked. No attempt starts while one is (a retry must not outrun its answer). */
  let withdrawing = 0
  /**
   * The version a withdrawal could NOT confirm gone, or null, and whether the check found it definitely still armed.
   * Kept apart from any attempt: whatever is current, the person reads that this version may (armed: will) install
   * when SlideWell quits, until a later clean check.
   */
  let unconfirmed: { version: string; armed: boolean } | null = null

  const set = (event: InstallEvent): void => {
    const next = installStep(state, event)
    if (next === state) return
    state = next
    ports.changed()
  }
  const live = (a: Attempt | null): a is Attempt => a !== null && a === current && !a.ended
  /** The blockers now. A read that fails holds the restart back (fail closed). */
  const blockersNow = (): RestartBlocker[] => {
    try { return ports.blockers() } catch (error) { ports.log(`the restart blockers could not be read (${String((error as Error)?.message ?? error)}): held`); return ['unsaved'] }
  }
  const message = (error: unknown): string => String((error as Error)?.message ?? error)

  /** Releases an ended attempt's files. Safe to call more than once; only once its download chain has settled. */
  function releaseOnce(a: Attempt): void {
    if (a.settled && !a.released) { a.released = true; ports.releaseFiles() }
  }
  function stopWatchdog(a: Attempt): void {
    if (a.watchdog !== null) { timers.clear(a.watchdog); a.watchdog = null }
  }

  /** Ends the attempt now (Cancel, a failure): the state changes at once. Never used once Squirrel.Mac may be armed. */
  function end(a: Attempt, event: InstallEvent, why: string): void {
    if (!live(a)) return
    a.ended = true
    current = null
    stopWatchdog(a)
    if (!a.settled) a.token.cancel()
    ports.log(`attempt ${a.id} ended: ${why}`)
    set(event)
    releaseOnce(a)
    if (a.closing) ports.commitAbandoned?.()
  }
  const fail = (a: Attempt, reason: FailReason, why: string): void => end(a, { type: 'failed', reason }, `failed (${reason}): ${why}`)

  /**
   * Withdraws whatever Squirrel.Mac armed and checks it. `stillOpen`: Squirrel.Mac has not answered yet, so it may
   * still arm after this check; pending stays true until its answer arrives and a later check is clean.
   */
  async function withdrawAndCheck(a: Attempt, stillOpen: boolean): Promise<Withdrawal> {
    withdrawing += 1
    let w: Withdrawal
    try { w = await ports.withdrawNative() } catch (error) { ports.log(`the withdrawal failed: ${message(error)}`); w = { found: true, gone: false, after: 'unknown' } } finally { withdrawing -= 1 }
    // Only two definite answers count as gone; anything that says gone with something possibly left is not.
    if (w.gone && w.after !== 'absent') w = { ...w, gone: false }
    if (w.found || !w.gone) spent = true
    ports.log(w.gone
      ? `withdrawal checked: no ShipIt job and no install request${stillOpen ? ' (Squirrel.Mac has not answered yet: it may still prepare)' : ''}`
      : `withdrawal NOT confirmed (afterwards: ${w.after}): the update ${w.after === 'present' ? 'will' : 'may'} install when SlideWell quits`)
    if (!w.gone) {
      unconfirmed = { version: a.offer.version, armed: w.after === 'present' }
      showUnconfirmed()
    } else if (!stillOpen && nativeOwner === null) {
      unconfirmed = null
      if (state.phase === 'reopen' && state.pending && state.version === a.offer.version) {
        state = { ...state, pending: false, armed: false }
        ports.changed()
      }
    }
    return w
  }

  /** An unconfirmed withdrawal is shown as "may (armed: will) finish updating when it next quits", over anything
   *  that says less. */
  function showUnconfirmed(): void {
    if (unconfirmed === null || live(current)) return
    const cause: ReopenCause = state.phase === 'reopen' ? state.cause : 'install-failed'
    const next: InstallPhase = { phase: 'reopen', version: unconfirmed.version, cause, pending: true, armed: unconfirmed.armed }
    if (state.phase === 'reopen' && state.pending && state.version === next.version && state.armed === next.armed) return
    state = next
    ports.changed()
  }

  /** Ends an attempt with no change of state: what the person reads follows once its outcome is known. */
  function endQuietly(a: Attempt, why: string): void {
    a.ended = true
    current = null
    stopWatchdog(a)
    a.quitting = false
    ports.log(`attempt ${a.id} ended: ${why}`)
    releaseOnce(a)
  }

  /**
   * D4: the restart cannot happen now and Squirrel.Mac may have armed ShipIt. The attempt ends, the run is spent,
   * the person reads at once that the update may finish when SlideWell quits; a checked withdrawal then says
   * "quit and reopen" instead.
   */
  function leftover(a: Attempt, cause: ReopenCause, why: string): void {
    if (!live(a)) return
    a.ended = true
    current = null
    stopWatchdog(a)
    a.quitting = false
    spent = true
    ports.log(`attempt ${a.id} ended with Squirrel.Mac possibly armed: ${why}`)
    set({ type: 'leftover', cause })
    releaseOnce(a)
    void withdrawAndCheck(a, a.asked && !a.answered)
    if (a.closing) { try { ports.commitAbandoned?.() } catch (error) { ports.log(`after the abandoned restart: ${message(error)}`) } }
  }

  function armWatchdog(a: Attempt): void {
    stopWatchdog(a)
    a.watchdog = timers.set(() => {
      a.watchdog = null
      if (!live(a)) return
      if (a.asked || a.quitting) leftover(a, a.quitting ? 'install-failed' : a.closing ? 'held' : 'no-answer', a.closing ? 'the windows did not close in time' : 'the restart did not happen in time')
      else fail(a, 'other', 'the hand-over to Squirrel.Mac did not finish in time')
    }, RESTART_WATCHDOG_MS)
  }

  /** How many windows are open; a count that cannot be read counts as open. */
  const windowsNow = (): number => {
    try { const n = ports.openWindows(); return Number.isInteger(n) && n >= 0 ? n : 1 } catch (error) { ports.log(`the open windows could not be counted (${message(error)}): held`); return 1 }
  }

  /** Stop SlideWell work and save while the native installer is still unarmed. */
  async function prepareRestart(a: Attempt, file: string): Promise<void> {
    a.closing = true
    try {
      if (!(await ports.closeWindows()) || !live(a)) {
        if (live(a)) fail(a, 'save', 'a window could not close safely')
        return
      }
      if (!(await ports.drainWriteQueues()) || !live(a)) {
        if (live(a)) fail(a, 'save', 'a write did not finish')
        return
      }
      if (!safeToAsk(a)) return
      await ports.handOver(file)
      if (safeToAsk(a)) ask(a)
    } catch (error) {
      if (live(a)) fail(a, failReasonOf(error), `could not prepare restart: ${message(error)}`)
    }
  }

  function safeToAsk(a: Attempt): boolean {
    if (!live(a) || state.phase !== 'restarting') return false
    if (blockersNow().length || windowsNow() || busyWrites() || ports.gate(a.offer) !== null) {
      fail(a, 'save', 'SlideWell could not safely restart before the native request')
      return false
    }
    return true
  }

  function busyWrites(): boolean {
    try { return ports.writeQueuesBusy().length > 0 } catch { return true }
  }

  /**
   * THE ONLY CALL OF THE NATIVE INSTALL. Every window has closed; in this one synchronous turn: is the attempt still
   * the live one, still restarting, does nothing hold a restart back, and is no window open? Only then quit and install.
   */
  function quitIfPermitted(a: Attempt): boolean {
    if (!live(a) || !a.ready || !a.closing || a.quitting || state.phase !== 'restarting') return false
    const blockers = blockersNow()
    if (blockers.length > 0) {
      ports.log(`the restart is held (${blockers.join(', ')}) after the windows closed`)
      leftover(a, 'held', `held by ${blockers.join(', ')}`)
      return false
    }
    const open = windowsNow()
    if (open > 0) {
      leftover(a, 'held', `${open} window${open === 1 ? ' is' : 's are'} open again`)
      return false
    }
    if (busyWrites() || ports.gate(a.offer) !== null) {
      leftover(a, 'held', 'the update or write state changed during native preparation')
      return false
    }
    a.quitting = true
    ports.log(`restarting into ${a.offer.version}: ${open} windows open (hidden ones included), no blocker, every write queue idle`)
    try { ports.native().quitAndInstall() } catch (error) { leftover(a, 'install-failed', `the native install refused: ${message(error)}`); return false }
    return true
  }

  /**
   * Squirrel.Mac refused to prepare (it checks the signature before it writes its request). The attempt ends at
   * once, but the state stays "restarting" (no Try again) until the withdrawal has been checked: then failed with
   * the reason, or, when it could not be confirmed, "reopen" with pending = true.
   */
  async function refusedByNative(a: Attempt, reason: FailReason, why: string): Promise<void> {
    if (!live(a)) return
    endQuietly(a, `failed (${reason}): ${why}; checking that nothing is armed`)
    const w = await withdrawAndCheck(a, false)
    if (state.phase !== 'restarting' || state.version !== a.offer.version || live(current)) return
    if (w.gone) set({ type: 'failed', reason })
    else showUnconfirmed()
    if (a.closing) ports.commitAbandoned?.()
  }

  /** One answer from Squirrel.Mac to the one question asked (prepare), or an error after the install was called. */
  function nativeAnswer(kind: 'ready' | 'none' | 'error', error?: unknown): void {
    const asked = nativeOwner
    nativeOwner = null
    if (asked) asked.answered = true
    if (kind === 'ready') spent = spent || asked !== null
    if (asked && live(asked) && !asked.quitting) {
      if (kind === 'ready') { asked.ready = true; quitIfPermitted(asked) }
      else void refusedByNative(asked, kind === 'none' ? 'other' : failReasonOf(error), kind === 'none' ? 'Squirrel.Mac found no update at the local address' : `Squirrel.Mac: ${message(error)}`)
    } else if (!asked && kind === 'error' && current && live(current) && current.quitting) {
      leftover(current, 'install-failed', `the install failed: ${message(error)}`)
    } else if (asked) {
      // The answer to an attempt that has ended (the watchdog): whatever it armed is withdrawn and checked.
      ports.log(`Squirrel.Mac answered (${kind}) for an attempt that has ended: withdrawn`)
      void withdrawAndCheck(asked, false)
    }
  }

  /** The last checks before the native request, then the request (D3). */
  function ask(a: Attempt): void {
    if (!live(a) || state.phase !== 'restarting') return
    // The spent flag and the one-question rule, re-read immediately before any native request.
    if (spent || nativeOwner) { fail(a, 'reopen', 'Squirrel.Mac was already used in this run'); return }
    const native = ports.native()
    if (!nativeHooked) {
      nativeHooked = true
      native.on('update-downloaded', () => nativeAnswer('ready'))
      native.on('update-not-available', () => nativeAnswer('none'))
      native.on('error', (error: unknown) => nativeAnswer('error', error))
    }
    nativeOwner = a
    a.asked = true
    ports.log(`preparing ${a.offer.version} (Squirrel.Mac checks the new app)`)
    try { native.checkForUpdates() } catch (error) { nativeOwner = null; a.answered = true; void refusedByNative(a, failReasonOf(error), 'Squirrel.Mac could not be asked') }
  }

  /** D3: the person's action means restart now. Re-read the blockers; only then hand the verified file to Squirrel.Mac. */
  function restartNow(a: Attempt): void {
    if (!live(a) || a.file === null) return
    const refusal = ports.gate(a.offer)
    if (refusal !== null) { fail(a, 'other', refusal); return }
    const blockers = blockersNow()
    if (blockers.length > 0) {
      if (state.phase === 'downloading') { ports.log(`downloaded ${a.offer.version}; the restart waits, nothing armed: ${blockers.join(', ')}`); set({ type: 'downloaded', blockers }) }
      else ports.log(`restart refused: ${blockers.join(', ')}`)
      return
    }
    if (spent) { fail(a, 'reopen', 'Squirrel.Mac was already used in this run'); return }
    set({ type: 'prepare' })
    if (state.phase !== 'restarting') return
    armWatchdog(a)
    void prepareRestart(a, a.file)
  }

  async function fetchAndCheck(a: Attempt): Promise<FailReason | 'ended' | { file: string }> {
    try {
      if (!live(a)) return 'ended'
      const updater = ports.downloader()
      const newer = await updater.check(a.offer)
      if (!live(a)) return 'ended'
      if (!newer) { ports.log(`${a.offer.version} is not newer than the running version`); return 'other' }
      const file = await updater.retrieve(a.token, (received, total) => {
        if (!live(a) || state.phase !== 'downloading') return
        const t = now()
        if (received < total && t - lastTold < 250) { state = installStep(state, { type: 'progress', received, total }); return }
        lastTold = t
        set({ type: 'progress', received, total })
      })
      if (!live(a)) return 'ended'
      const problem = await ports.verify(file, a.offer)
      if (!live(a)) return 'ended'
      if (problem) { ports.log(`the downloaded file was refused (${problem})`); return problem }
      return { file }
    } catch (error) {
      if (!live(a)) return 'ended'
      ports.log(`download failed: ${message(error)}`)
      return failReasonOf(error)
    } finally {
      a.settled = true
      if (a.ended) releaseOnce(a)
    }
  }

  return {
    state: (): InstallPhase => state,
    /** The click on Update (or Try again): D1 (download and check, ours alone), then D3 at once or D2. */
    async start(offer: Offer): Promise<InstallPhase> {
      if (ports.platform !== 'darwin') { ports.log(`no in-place update on ${ports.platform} in this release (ADR-0044 §5): refused before any download`); return state }
      if (state.phase !== 'idle' && state.phase !== 'failed') return state
      // A withdrawal still being checked decides whether this run may ask Squirrel.Mac again: wait for its answer.
      if (withdrawing > 0) { ports.log('a withdrawal is still being checked: Update waits for its answer'); return state }
      const refused = ports.gate(offer)
      if (refused !== null) { ports.log(`update refused: ${refused}`); return state }
      if (spent) {
        ports.log('Squirrel.Mac cannot install again in this run: reopen SlideWell first')
        state = { phase: 'failed', version: offer.version, reason: 'reopen' }
        ports.changed()
        return state
      }
      const a: Attempt = { id: ++seq, offer, token: new CancellationToken(), ended: false, settled: false, released: false, file: null, asked: false, answered: false, ready: false, closing: false, quitting: false, watchdog: null }
      current = a
      set({ type: 'start', version: offer.version, total: offer.size })
      let settle!: () => void
      const before = previous
      previous = new Promise<void>((resolve) => { settle = resolve })
      const chain = (async () => { await before.catch(() => {}); return fetchAndCheck(a) })()
      const outcome = await chain.finally(() => settle())
      if (outcome === 'ended' || !live(a)) return state
      if (typeof outcome === 'string') { fail(a, outcome, 'the download did not pass its checks'); return state }
      a.file = outcome.file
      restartNow(a)
      return state
    },
    /** Cancel: in D1 (downloading) and D2 (waiting) only; nothing native exists then. No Cancel once restarting. */
    cancel(): InstallPhase {
      const a = current
      if (!live(a) || (state.phase !== 'downloading' && state.phase !== 'waiting')) return state
      end(a, { type: 'cancelled' }, 'cancelled by the person')
      return state
    },
    /** Restart, from any window, the palette's answer or the menu's: D3 only when nothing holds it back now. */
    restart(): InstallPhase {
      const a = current
      if (!live(a) || state.phase !== 'waiting') return state
      restartNow(a)
      return state
    },
    /** The offer changed: a failed attempt starts again from Update. */
    reset(): void { set({ type: 'reset' }) },
    /** Test and diagnosis only: the live attempt's identity, or null. */
    attemptId: (): number | null => (live(current) ? current.id : null),
  }
}
export type UpdateEngine = ReturnType<typeof createUpdateEngine>

// ── electron-updater, adapted ─────────────────────────────────────────────────────────────────────

/** The provider electron-updater asks: it answers with the version already chosen and makes no request. */
type OfferOptions = { provider: 'custom'; updateProvider: unknown; offer: () => UpdateInfo | null }
export class OfferProvider extends Provider<UpdateInfo> {
  private readonly offer: () => UpdateInfo | null
  constructor(options: OfferOptions, _updater: unknown, runtimeOptions: ProviderRuntimeOptions) {
    super(runtimeOptions)
    this.offer = options.offer
  }
  getLatestVersion(): Promise<UpdateInfo> {
    const info = this.offer()
    return info ? Promise.resolve(info) : Promise.reject(new Error('No update was chosen'))
  }
  resolveFiles(info: UpdateInfo) {
    return info.files.map((file) => ({ url: new URL(file.url), info: file }))
  }
}

/**
 * Configures a MacUpdater as the download engine only, closes its own route to the native install and defers its
 * hand-over to Squirrel.Mac. With autoInstallOnAppQuit false it never asks Squirrel.Mac to check by itself; its
 * quitAndInstall() and handleUpdateDownloaded() (the only places it calls the native install, MacUpdater.js) refuse;
 * and its updateDownloaded() (which, at the end of every download, starts the local address and sets the native
 * feed) only records the download and tells its listeners. The returned handOver() runs the dependency's own
 * updateDownloaded() for that verified file: the engine calls it only at restart time (D3).
 */
export function closeDependencyInstallPath(u: AppUpdater, log: (message: string) => void): { handOver(file: string): Promise<void> } {
  u.autoDownload = false
  u.autoInstallOnAppQuit = false
  u.autoRunAppAfterInstall = true
  u.allowDowngrade = false
  u.allowPrerelease = true
  u.disableDifferentialDownload = true
  u.disableWebInstaller = true
  const refuse = (what: string) => (): void => { log(`refused: electron-updater's ${what} cannot install; only SlideWell's restart gate can`) }
  Object.defineProperty(u, 'quitAndInstall', { value: refuse('quitAndInstall'), writable: false, configurable: false })
  Object.defineProperty(u, 'handleUpdateDownloaded', { value: refuse('handleUpdateDownloaded'), writable: false, configurable: false })
  type Mac = { updateDownloaded(zip: unknown, event: { downloadedFile?: string }): Promise<string[]>; dispatchUpdateDownloaded(event: unknown): void }
  const mac = u as unknown as Mac
  const ownHandOver = mac.updateDownloaded.bind(u)
  let last: { zip: unknown; event: { downloadedFile?: string } } | null = null
  Object.defineProperty(u, 'updateDownloaded', {
    value: async (zip: unknown, event: { downloadedFile?: string }): Promise<string[]> => { last = { zip, event }; mac.dispatchUpdateDownloaded(event); return [] },
    writable: false, configurable: false,
  })
  return {
    async handOver(file: string): Promise<void> {
      if (!last || last.event?.downloadedFile !== file) throw new Error('no verified download to hand over')
      await ownHandOver(last.zip, last.event)
    },
  }
}

/** The Downloader over a real electron-updater AppUpdater whose feed is OfferProvider(() => chosen). */
export function dependencyDownload(u: AppUpdater, choose: (info: UpdateInfo) => void): Downloader {
  let downloaded: string | null = null
  let onProgress: ((received: number, total: number) => void) | null = null
  u.on('update-downloaded', (event: { downloadedFile?: string }) => { downloaded = event?.downloadedFile ?? null })
  u.on('download-progress', (p: { transferred: number; total: number }) => onProgress?.(p.transferred, p.total))
  return {
    async check(offer) {
      choose({
        version: offer.version,
        files: [{ url: offer.url, sha512: offer.sha512, size: offer.size }],
        path: offer.url,
        sha512: offer.sha512,
        releaseDate: `${offer.released}T00:00:00.000Z`,
      })
      const result = await u.checkForUpdates()
      return result?.isUpdateAvailable === true
    },
    async retrieve(token, progress) {
      downloaded = null
      onProgress = progress
      try { await u.downloadUpdate(token) } finally { onProgress = null }
      if (!downloaded) throw new Error('electron-updater reported no downloaded file')
      return downloaded
    },
  }
}

// ── The downloaded file: its size and the version inside ─────────────────────────────────────────

function run(cmd: string, args: string[], input?: Buffer, limit = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    let bytes = 0
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${cmd} took too long`)) }, 60_000)
    child.stdout.on('data', (c: Buffer) => { bytes += c.length; if (bytes > limit) { child.kill('SIGKILL'); return } chunks.push(c) })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => { clearTimeout(timer); if (code === 0 && bytes <= limit) resolve(Buffer.concat(chunks)); else reject(new Error(`${cmd} exited ${code}`)) })
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? undefined)
  })
}

/** CFBundleShortVersionString and CFBundleIdentifier of the one app at the top of a Mac update zip. */
export async function readZippedAppPlist(zip: string): Promise<{ version: string; bundleId: string } | null> {
  const names = (await run('/usr/bin/unzip', ['-Z1', zip])).toString('utf8').split('\n').map((n) => n.replace(/\r$/, '')).filter(Boolean)
  if (names.some((name) => /[\u0000-\u001f\u007f\\]/.test(name) ||
    name.replace(/\/$/, '').split('/').some((part) => part === '' || part === '.' || part === '..'))) return null
  const plists = names.filter((n) => /^[^/]+\.app\/Contents\/Info\.plist$/.test(n) && !n.startsWith('__MACOSX/'))
  // Exactly one app at the top, named once, with no wildcard characters unzip would expand.
  const apps = new Set(names.filter((n) => !n.startsWith('__MACOSX/')).map((n) => n.split('/')[0]))
  if (plists.length !== 1 || apps.size !== 1 || /[*?[\]\\]/.test(plists[0])) return null
  const plist = await run('/usr/bin/unzip', ['-p', zip, plists[0]], undefined, 1024 * 1024)
  const read = async (key: string) => (await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', '-'], plist)).toString('utf8').trim()
  try { return { version: await read('CFBundleShortVersionString'), bundleId: await read('CFBundleIdentifier') } } catch { return null }
}

/**
 * Before Squirrel.Mac sees the file: its size is the feed's (the size becomes the local address's Content-Length),
 * and the app inside is the version offered, newer than the running one, with the bundle identifier the feed
 * states. A genuinely signed older build put under a newer name is refused here (Squirrel.Mac checks only the
 * signature).
 */
export async function verifyMacDownload(file: string, offer: Offer, running: string): Promise<FailReason | null> {
  const size = (await stat(file)).size
  if (size !== offer.size) return 'mismatch'
  const inside = await readZippedAppPlist(file).catch(() => null)
  if (!inside) return 'wrong-version'
  if (inside.version !== offer.version) return 'wrong-version'
  if (compareVersions(inside.version, running) <= 0) return 'wrong-version'
  if (inside.bundleId !== offer.bundleId) return 'wrong-version'
  return null
}
