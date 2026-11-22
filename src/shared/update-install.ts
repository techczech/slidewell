// Updating in place (ADR-0044): the states of the one click, what holds a restart back, when a copy cannot
// replace itself, and every word the person reads about it. Pure: no Electron; unit-tested in
// scripts/test-update-install.mjs. The engine is src/main/update-installer.ts; the screens are
// UpdateNotices.tsx and AboutUpdatesSettings.tsx.
import type { UpdateFile } from './update-channels.ts'

// ── What holds a restart back ───────────────────────────────────────────────────────────────────

export type RestartBlocker = 'work' | 'unsaved' | 'settings' | 'window'

const BLOCKER_TEXT: Record<RestartBlocker, string> = {
  work: 'Wait for SlideWell to finish its current work.',
  unsaved: 'SlideWell could not save its state. Check your settings before restarting.',
  settings: 'Close Settings to restart.',
  window: 'Close the other SlideWell windows to restart.'
}

export function blockersSentence(blockers: readonly RestartBlocker[]): string {
  return blockers.map((blocker) => BLOCKER_TEXT[blocker]).join(' ')
}

// ── When a copy cannot replace itself ───────────────────────────────────────────────────────────

export type InPlaceRefusal = 'store' | 'development' | 'platform' | 'no-file' | 'disk-image' | 'translocated' | 'read-only' | 'other-copy'

export interface InPlaceFacts {
  platform: string
  arch: string
  /** website, store, preview or development (copySource). */
  source: string
  /** The update file the feed names for this computer, if any. */
  file: UpdateFile | null
  /** Mac: the running bundle's path (`/Applications/SlideWell.app`); Windows: the folder holding the program. */
  appPath: string
  /** The bundle (or program folder) and the folder holding it can be written by this account. */
  writable: boolean
  /** The error code of the write check when it failed (EROFS on a disk image). */
  writeError?: string | null
  /** Mac: CFBundleIdentifier of the running app, or null when it could not be read. */
  bundleId: string | null
}

/** Why this copy cannot update itself in place, or null when it can. */
export function inPlaceRefusal(facts: InPlaceFacts): InPlaceRefusal | null {
  if (facts.source === 'store') return 'store'
  if (facts.source === 'development') return 'development'
  if (facts.platform !== 'darwin' || facts.arch !== 'arm64') return 'platform'
  if (!facts.file) return 'no-file'
  if (facts.platform === 'darwin') {
    if (facts.appPath.includes('/AppTranslocation/')) return 'translocated'
    if (facts.appPath.startsWith('/Volumes/') && (facts.writeError === 'EROFS' || !facts.writable)) return 'disk-image'
    if (facts.writeError === 'EROFS') return 'disk-image'
  }
  if (!facts.writable) return 'read-only'
  if (facts.platform === 'darwin' && facts.bundleId !== facts.file.bundleId) return 'other-copy'
  return null
}

export const REFUSAL_TEXT: Record<InPlaceRefusal, string> = {
  store: 'The Mac App Store installs new versions of this copy.',
  development: 'This copy was started from source and does not update itself.',
  platform: 'SlideWell updates itself only on Apple silicon Macs.',
  'no-file': 'This version is only on the download page.',
  'disk-image': 'SlideWell cannot replace itself here: it is running from a disk image. Move it to Applications and open it from there.',
  translocated: 'SlideWell cannot replace itself here: macOS is running it from a temporary place. Move it to Applications and open it again.',
  'read-only': 'SlideWell cannot replace itself here: this account cannot change the app’s folder.',
  'other-copy': 'SlideWell cannot replace itself here: this copy was built for testing.',
}

// ── The states of the click ─────────────────────────────────────────────────────────────────────

export type FailReason = 'network' | 'mismatch' | 'wrong-version' | 'save' | 'signature' | 'disk' | 'reopen' | 'other'

/** Why a restart the person asked for did not happen while macOS may have prepared the update (ADR-0044 §3, D4). */
export type ReopenCause = 'held' | 'no-answer' | 'install-failed'

export type InstallPhase =
  | { phase: 'idle' }
  /** D1: SlideWell downloads and checks the file; macOS is not involved yet. Cancel. */
  | { phase: 'downloading'; version: string; received: number; total: number }
  /** D2: downloaded and checked; a reason not to restart holds. Nothing is handed to macOS; Restart waits for the person. */
  | { phase: 'waiting'; version: string }
  /** D3: the person committed to restarting: macOS prepares and checks the new version, then, if nothing holds it back at that moment, the app quits. No Cancel. */
  | { phase: 'restarting'; version: string }
  | { phase: 'failed'; version: string; reason: FailReason }
  /**
   * D4: the restart did not happen and macOS may have prepared the update; nothing more happens in this run.
   * pending: true until a withdrawal has been checked (the update may install when SlideWell next quits); false
   * once it was checked that nothing is armed (quit and reopen SlideWell, then press Update again).
   * armed: true only when a check found the preparation definitely still there (Squirrel.Mac's ShipIt job and its
   * install request both present after the withdrawal): then, and only then, the update WILL install at the next
   * quit. Every other unconfirmed withdrawal (not yet checked, an unknown answer, one of the two gone) says "may".
   */
  | { phase: 'reopen'; version: string; cause: ReopenCause; pending: boolean; armed: boolean }

export type InstallEvent =
  | { type: 'start'; version: string; total: number }
  | { type: 'progress'; received: number; total?: number }
  | { type: 'downloaded'; blockers: readonly RestartBlocker[] }
  | { type: 'cancelled' }
  | { type: 'failed'; reason: FailReason }
  | { type: 'restart'; blockers: readonly RestartBlocker[] }
  /** Permission given (nothing held the restart back): macOS prepares the new version. */
  | { type: 'prepare' }
  /** Something holds the restart back before macOS was asked: back to waiting, nothing armed. */
  | { type: 'held' }
  /** The restart did not happen while macOS may have prepared it (D4). */
  | { type: 'leftover'; cause: ReopenCause }
  /** The offer changed under a state that is not working (a newer version, or none): start again. */
  | { type: 'reset' }

export const IDLE: InstallPhase = { phase: 'idle' }

/** One step. Anything not listed leaves the state as it is. */
export function installStep(state: InstallPhase, event: InstallEvent): InstallPhase {
  switch (event.type) {
    case 'start':
      return state.phase === 'idle' || state.phase === 'failed'
        ? { phase: 'downloading', version: event.version, received: 0, total: event.total } : state
    case 'progress':
      return state.phase === 'downloading'
        ? { ...state, received: Math.max(0, Math.min(event.received, event.total ?? state.total)), total: event.total ?? state.total } : state
    case 'downloaded':
      if (state.phase !== 'downloading') return state
      return event.blockers.length === 0 ? { phase: 'restarting', version: state.version } : { phase: 'waiting', version: state.version }
    case 'cancelled':
      // No Cancel once restarting: the person has committed, and macOS may already be preparing it.
      return state.phase === 'downloading' || state.phase === 'waiting' ? IDLE : state
    case 'failed':
      return state.phase === 'downloading' || state.phase === 'restarting' || state.phase === 'waiting'
        ? { phase: 'failed', version: state.version, reason: event.reason } : state
    case 'restart':
      return state.phase === 'waiting' && event.blockers.length === 0 ? { phase: 'restarting', version: state.version } : state
    case 'prepare':
      return state.phase === 'downloading' || state.phase === 'waiting' ? { phase: 'restarting', version: state.version } : state
    case 'held':
      return state.phase === 'restarting' ? { phase: 'waiting', version: state.version } : state
    case 'leftover':
      return state.phase === 'restarting' ? { phase: 'reopen', version: state.version, cause: event.cause, pending: true, armed: false } : state
    case 'reset':
      return state.phase === 'failed' ? IDLE : state
  }
}

/** Whether the app is working on an update, or has one left over (the mark stays, whatever the offer). */
export const installBusy = (state: InstallPhase): boolean => state.phase === 'downloading' || state.phase === 'waiting' || state.phase === 'restarting' || state.phase === 'reopen'

/** What went wrong, from an error electron-updater or Squirrel.Mac reported. */
export function failReasonOf(error: unknown): FailReason {
  const e = (error ?? {}) as { code?: unknown; message?: unknown }
  const code = typeof e.code === 'string' ? e.code : ''
  const message = typeof e.message === 'string' ? e.message : String(error ?? '')
  if (code === 'ERR_CHECKSUM_MISMATCH' || /sha512 checksum mismatch|checksum mismatch|size mismatch|ERR_UPDATER_.*SIZE/i.test(message)) return 'mismatch'
  if (code === 'ERR_UPDATER_INVALID_SIGNATURE' || /code signature|did not pass validation|code requirement|not signed by the application owner|SQRLCodeSignature/i.test(message)) return 'signature'
  if (code === 'ENOSPC' || /ENOSPC|no space left/i.test(message)) return 'disk'
  if (/net::ERR_|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|Cannot download|status code|HttpError|aborted|ERR_STREAM_PREMATURE_CLOSE|premature/i.test(message + ' ' + code)) return 'network'
  return 'other'
}

export const FAIL_TEXT: Record<FailReason, string> = {
  network: 'The download stopped: github.com could not be reached.',
  mismatch: 'The downloaded file did not match the published one, so it was not used.',
  'wrong-version': 'The download was not the version offered, so it was not installed.',
  save: 'SlideWell could not finish saving before restarting. Check your settings and try again.',
  signature: 'The new version is not signed by SlideWell’s developer, so it was not installed.',
  disk: 'There is not enough space on this computer.',
  reopen: 'An earlier update was stopped part-way. Quit and reopen SlideWell, then press Update again.',
  other: 'Something went wrong while updating.',
}

/** "275 MB" (decimal megabytes, as Finder shows them). */
export function sizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const mb = bytes / 1_000_000
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`
}

/** The status-bar mark for the click's state, or null when the plain "is available" mark (or none) applies. */
export function installMarkText(state: InstallPhase): string | null {
  switch (state.phase) {
    case 'downloading': return `Downloading ${state.version} · ${state.total > 0 ? Math.floor((state.received / state.total) * 100) : 0}%`
    case 'waiting': return 'Restart to finish updating'
    case 'restarting': return `Restarting into ${state.version}…`
    case 'failed': return `Update to ${state.version} failed`
    case 'reopen': return reopenText(state).mark
    default: return null
  }
}

/**
 * What the person reads in the D4 state. Never "nothing will install" unless a withdrawal was checked (pending
 * false); never "will install" unless a check found the preparation still there (armed); otherwise "may".
 */
export function reopenText(state: { version: string; cause: ReopenCause; pending: boolean; armed: boolean }): { mark: string; title: string; detail: string } {
  const why = state.cause === 'held'
    ? 'Something started that a restart would interrupt, so SlideWell did not restart.'
    : state.cause === 'no-answer'
      ? `macOS did not finish preparing ${state.version} in time, so SlideWell did not restart.`
      : `macOS could not finish installing ${state.version}, so SlideWell did not restart.`
  if (!state.pending) return {
    mark: 'Reopen SlideWell to update',
    title: 'Quit and reopen SlideWell to update',
    detail: `${why} Nothing is installed when it quits. Quit and reopen SlideWell, then press Update again.`,
  }
  return {
    mark: 'Update restart is on hold',
    title: 'SlideWell could not finish restarting',
    detail: `${why} Quit is paused while macOS may still have this update prepared.`,
  }
}

/** The popover's foot under Update. */
export const updateFoot = (version: string, file: UpdateFile): string =>
  `Update downloads ${version} (${sizeText(file.size)}), replaces this copy and restarts SlideWell. Your library and settings stay as they are.`

/** The popover's foot when the download page is the way. */
export const DOWNLOAD_FOOT = 'Download opens the download page in your browser. Install it as you installed this one; your talks and settings stay as they are.'

/** The alpha switch's sentence in Settings. */
export const ALPHA_HINT = 'Alpha builds arrive early and may be less reliable. Turning this off keeps your current build until a newer release is available.'
