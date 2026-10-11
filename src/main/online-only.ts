/**
 * Online-only files (ticket 15): iCloud Desktop with optimised storage and OneDrive placeholders keep
 * a file's name and size on disk but not its bytes (SF_DATALESS). Small interface:
 *   isOnlineOnly(path)                 → true for a dataless regular file (never opens it)
 *   captureDownloadRoot(source, known) → the canonical folder a capture source may download in, or null
 *   downloadOnlineOnly(path, opts)     → asks macOS to download one file, with a timeout and Stop
 *   downloadWithDeadline(path, dl, o)  → runs any downloader under the timeout and Stop
 *
 * The download runs OUT OF PROCESS: a child (this app's own binary in Node mode) opens the file with
 * O_NOFOLLOW, checks with fstat that the descriptor it holds is a regular file with the same device and
 * inode this process checked with lstat, and only then reads it to the end, which makes macOS (File
 * Provider) fetch it. A swapped-in symlink, FIFO, device or other file is refused before a byte is read.
 * SlideWell itself never opens a dataless file: a read blocked on a download inside this process holds
 * a libuv worker until the OS returns, and four of them would stall every file operation in the app. A
 * child can always be killed: on the timeout or Stop it gets SIGKILL. The download only reads; nothing
 * is written, moved or deleted. Callers re-check `isOnlineOnly` afterwards before opening the file.
 */
import { execFile, spawn } from 'node:child_process'
import { promises as fsp, realpath as realpathCb } from 'node:fs'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

const SF_DATALESS = 0x40000000

/** A cloud placeholder whose bytes are not on disk (SF_DATALESS). Cheap: only zero-block files are asked about. */
export async function isOnlineOnly(path: string): Promise<boolean> {
  const st = await fsp.lstat(path).catch(() => null)
  if (!st || !st.isFile() || st.size === 0 || st.blocks > 0) return false
  return new Promise((resolve) =>
    execFile('/usr/bin/stat', ['-f', '%Xf', '--', path], { timeout: 3000 }, (err, out) => resolve(err ? true : (parseInt(String(out).trim(), 16) & SF_DATALESS) !== 0))
  )
}

const realpathNative = promisify(realpathCb.native)
const canonical = async (p: string | null | undefined, real: (p: string) => Promise<string>): Promise<string | null> => (p ? real(p).catch(() => null) : null)

/**
 * Download authority for a capture source (ticket 15), decided on canonical paths (realpath) so no
 * alias, `..` or symlink can widen it: the source must BE the Desktop or CleanShot's export folder,
 * and never the primary Triage folder, by whatever name. Returns the canonical root, else null.
 */
export async function captureDownloadRoot(
  source: string,
  known: { desktop: string | null; cleanshotExport: string | null; primary: string | null },
  real: (p: string) => Promise<string> = realpathNative
): Promise<string | null> {
  const [s, desktop, cleanshot, primary] = await Promise.all([source, known.desktop, known.cleanshotExport, known.primary].map((p) => canonical(p, real)))
  if (!s || (primary && s === primary)) return null
  return s === desktop || s === cleanshot ? s : null
}

export type DownloadOptions = {
  timeoutMs: number
  signal?: AbortSignal
  /** Canonical folder the file must be in (captureDownloadRoot or the backlog's resolved source). */
  root: string
  /** Test seam: called with the child's pid once it is running. */
  onSpawn?: (pid: number) => void
}

const abortError = (): Error => Object.assign(new Error('stopped'), { code: 'ABORT_ERR' })
const coded = (message: string, code: string): Error => Object.assign(new Error(message), { code })

// Runs in the child. argv tail: path, dev, ino. Exit 0 = read to the end; 3 = not the file that was
// checked; 4 = not a regular file (or a link); 5 = open failed; anything else = read failed.
const CHILD = `
const fs = require('fs');
const [p, dev, ino] = process.argv.slice(-3);
let fd;
try { fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
catch (e) { process.exit(e && e.code === 'ELOOP' ? 4 : 5); }
const st = fs.fstatSync(fd, { bigint: true });
if (!st.isFile()) process.exit(4);
if (String(st.dev) !== dev || String(st.ino) !== ino) process.exit(3);
const b = Buffer.allocUnsafe(1 << 20);
while (fs.readSync(fd, b, 0, b.length, null) > 0) {}
process.exit(0);
`

/**
 * Download one online-only file by reading it in a child process. Resolves when the read finished;
 * rejects with code ETIMEDOUT (no download within `timeoutMs`), ABORT_ERR (Stop), ENOTREG (not a
 * regular file), EOUTSIDE (not inside `root`), ECHANGED (the file was swapped after the check) or
 * EDOWNLOAD (the read failed, e.g. offline). Stop is checked again after every await, before spawning.
 */
export async function downloadOnlineOnly(path: string, opts: DownloadOptions): Promise<void> {
  if (opts.signal?.aborted) throw abortError()
  const st = await fsp.lstat(path, { bigint: true })
  if (!st.isFile()) throw coded('not a regular file', 'ENOTREG')
  const dir = await realpathNative(dirname(path))
  if (dir !== opts.root && !dir.startsWith(`${opts.root}/`)) throw coded('outside the folder it may download in', 'EOUTSIDE')
  if (opts.signal?.aborted) throw abortError()
  await new Promise<void>((resolve, reject) => {
    // stdin/stdout/stderr all /dev/null: nothing of the file reaches this process
    const child = spawn(process.execPath, ['-e', CHILD, '--', path, String(st.dev), String(st.ino)], { stdio: 'ignore', env: { ELECTRON_RUN_AS_NODE: '1' } })
    let settled = false
    const finish = (err: Error | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (err) {
        child.kill('SIGKILL')
        reject(err)
      } else resolve()
    }
    const onAbort = (): void => finish(abortError())
    const timer = setTimeout(() => finish(coded(`not downloaded within ${Math.round(opts.timeoutMs / 1000)} s`, 'ETIMEDOUT')), opts.timeoutMs)
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (e) => finish(coded(`download failed: ${e.message}`, 'EDOWNLOAD')))
    child.on('exit', (code) =>
      finish(
        code === 0
          ? null
          : code === 3
            ? coded('the file changed before it was read', 'ECHANGED')
            : code === 4
              ? coded('not a regular file', 'ENOTREG')
              : coded('download failed (offline, or the file is unavailable)', 'EDOWNLOAD')
      )
    )
    if (child.pid) opts.onSpawn?.(child.pid)
  })
}

/**
 * Run one download under a deadline and Stop, whatever the downloader does: rejects ETIMEDOUT after
 * `timeoutMs` and ABORT_ERR on Stop, and in both cases aborts the signal it handed the downloader
 * (the default downloader kills its child on that). Used by the backlog import and the capture scan.
 */
export function downloadWithDeadline(path: string, download: (path: string, opts: DownloadOptions) => Promise<void>, opts: DownloadOptions): Promise<void> {
  if (opts.signal?.aborted) return Promise.reject(abortError())
  const inner = new AbortController()
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (err: Error | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onStop)
      if (err) {
        inner.abort()
        reject(err)
      } else resolve()
    }
    const onStop = (): void => finish(abortError())
    const timer = setTimeout(() => finish(coded(`not downloaded within ${Math.round(opts.timeoutMs / 1000)} s`, 'ETIMEDOUT')), opts.timeoutMs)
    opts.signal?.addEventListener('abort', onStop, { once: true })
    Promise.resolve()
      .then(() => download(path, { ...opts, signal: inner.signal }))
      .then(
        () => finish(null),
        (e) => finish(e instanceof Error ? e : new Error(String(e)))
      )
  })
}
