/**
 * "Download them" in Review's Not on this Mac view: ask the cloud provider for each screenshot whose picture is a cloud
 * placeholder, one file at a time, and record what each file is afterwards.
 *
 * How a placeholder is made to download: the file is read, out of process, by online-only.ts downloadOnlineOnly (a child
 * of this app's own binary opens it O_NOFOLLOW, checks it is the same regular file, reads it to the end into nothing).
 * OneDrive, iCloud Drive and Dropbox all keep their files through macOS File Provider, which fetches a dataless file's
 * bytes when it is read, so one way serves all three, needs no extra permission and no provider tool (`brctl` is iCloud
 * only). Reading in a child keeps a stalled fetch from holding a worker of this process; the timeout and Cancel kill it.
 * Nothing is written to, moved or deleted from the file. Only a path the real-path guard allows (swarchive-guard.ts,
 * the roots swarchive:// serves from) and that lies inside its own source folder is asked for; any other is refused
 * without being read.
 *
 * After each file its state is checked again by metadata (size > 0 with no blocks = still a placeholder, the scan's test;
 * downloaded only on positive evidence: a regular file with size > 0 and blocks > 0) and the scan row's `offline` flag is
 * set to that (triage.ts setTriageOffline); a file that is missing or cannot be stat'ed counts as failed and its flag stays. One file failing or timing out never
 * stops the rest; Cancel stops before the next file.
 */
import { lstatSync } from 'node:fs'
import { downloadOnlineOnly, downloadWithDeadline, type DownloadOptions, type FileIdentity } from '../online-only'
import { realInside, realRoot, servableUnderRoots } from '../swarchive-guard'
import { datalessOnDisk, downloadedOnDisk } from './picture'

/**
 * One screenshot to fetch: the placeholder Review's picture chooser picked, and the scan row it came from: `source` is the
 * folder it lies in (the row's own, or the fallback for rows that carry none), `rowSource` the row's source as stored.
 */
export type DownloadTarget = { hash: string; abs: string; source: string; relPath: string; rowSource: string }

/** While it runs: `current` is the file being asked for now (1-based), 0 before the first and after the last. */
export type DownloadProgress = { running: boolean; total: number; current: number; done: number; failed: number }

export type DownloadOutcome = { total: number; done: number; failed: number; refused: number; cancelled: boolean }

export type DownloadLoopDeps = {
  /** The roots swarchive:// serves from (index.ts allowedRoots). Absent: only the target's own source folder. */
  allowedRoots?: () => string[]
  /** Asks for one file; default online-only.ts downloadOnlineOnly (reads it in a child process). */
  download?: (abs: string, opts: DownloadOptions) => Promise<void>
  /** Still a placeholder on disk; default picture.ts datalessOnDisk (metadata only). */
  dataless?: (abs: string) => boolean
  /**
   * Its bytes are on this Mac, by positive evidence (stat works, a regular file, size > 0, blocks > 0); default picture.ts
   * downloadedOnDisk. Only this counts a file as downloaded: one that is missing, cannot be stat'ed or is empty is a failure
   * and its offline flag is left as it was.
   */
  onDisk?: (abs: string) => boolean
  /** Record the file's state on its scan row (triage.ts setTriageOffline). */
  setOffline: (t: DownloadTarget, offline: boolean) => unknown
  /** Per file; default 60 s. */
  timeoutMs?: number
}

export const DOWNLOAD_TIMEOUT_MS = 60_000

/** The path may be asked for: allowed by the real-path guard and, by real path, inside its own source folder. */
function mayAsk(t: DownloadTarget, roots: string[] | null): boolean {
  if (!t.source || !t.abs) return false
  if (roots !== null && !servableUnderRoots(t.abs, roots)) return false
  return realInside([realRoot(t.source)], t.abs)
}

function identityOf(abs: string): FileIdentity | null {
  try {
    const st = lstatSync(abs, { bigint: true })
    return st.isFile() ? { dev: st.dev, ino: st.ino } : null
  } catch {
    return null
  }
}

export async function downloadTargets(
  targets: DownloadTarget[],
  deps: DownloadLoopDeps,
  opts: { signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void } = {}
): Promise<DownloadOutcome> {
  const download = deps.download ?? downloadOnlineOnly
  const dataless = deps.dataless ?? datalessOnDisk
  const onDisk = deps.onDisk ?? downloadedOnDisk
  // what the file is now: here (positive evidence only, and not a placeholder), a placeholder, or not known (missing, unreadable, empty)
  const stateOf = (abs: string): 'here' | 'placeholder' | 'unknown' => (dataless(abs) ? 'placeholder' : onDisk(abs) ? 'here' : 'unknown')
  const timeoutMs = deps.timeoutMs ?? DOWNLOAD_TIMEOUT_MS
  const out: DownloadOutcome = { total: targets.length, done: 0, failed: 0, refused: 0, cancelled: false }
  const tell = (current: number, running = true): void => opts.onProgress?.({ running, total: out.total, current, done: out.done, failed: out.failed })
  const record = (t: DownloadTarget, offline: boolean): void => {
    try {
      deps.setOffline(t, offline)
    } catch {
      /* the flag is a cache of the file's state; the next scan sets it again */
    }
  }
  const roots = deps.allowedRoots ? deps.allowedRoots() : null
  for (let i = 0; i < targets.length; i++) {
    if (opts.signal?.aborted) {
      out.cancelled = true
      break
    }
    const t = targets[i]
    tell(i + 1)
    if (!mayAsk(t, roots)) {
      out.failed++
      out.refused++
      continue
    }
    const before = stateOf(t.abs)
    if (before === 'here') {
      // already here (downloaded meanwhile, by him or the provider): nothing to ask for
      out.done++
      record(t, false)
      continue
    }
    if (before === 'unknown') {
      // gone, unreadable or empty: nothing to ask for, and nothing known to record
      out.failed++
      continue
    }
    const identity = identityOf(t.abs)
    if (!identity) {
      out.failed++
      continue
    }
    let stopped = false
    try {
      await downloadWithDeadline(t.abs, download, { timeoutMs, signal: opts.signal, root: realRoot(t.source), identity })
    } catch (e) {
      stopped = (e as NodeJS.ErrnoException)?.code === 'ABORT_ERR'
    }
    // what the file is now decides, whatever the download said (one that ended as the clock ran out still counts); only
    // positive evidence counts it as here, and a file that is now missing or unreadable leaves its flag as it was
    const after = stateOf(t.abs)
    if (after !== 'unknown') record(t, after === 'placeholder')
    if (after === 'here') out.done++
    else if (!stopped) out.failed++ // the one Cancel cut short is neither
    if (stopped) {
      out.cancelled = true
      break
    }
  }
  tell(0, false)
  return out
}
