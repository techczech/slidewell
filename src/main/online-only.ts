/**
 * Online-only files (ticket 15): iCloud Desktop with optimised storage and OneDrive placeholders keep
 * a file's name and size on disk but not its bytes (SF_DATALESS). Small interface:
 *   isOnlineOnly(path)            → true for a dataless regular file (never opens it)
 *   downloadOnlineOnly(path, opt) → asks macOS to download it, with a timeout and Stop
 *
 * The download runs OUT OF PROCESS: a `/bin/cat` child reads the file into /dev/null, which makes
 * macOS (File Provider) fetch it. SlideWell itself still never opens a dataless file. The reason: a
 * read blocked on a download inside this process occupies a libuv worker until the OS returns, and
 * four such reads would stall every file operation in the app. A child can always be killed: on the
 * timeout or Stop it gets SIGKILL and the file is left as it was. The download only reads; nothing is
 * written, moved or deleted. Callers re-check `isOnlineOnly` afterwards before opening the file.
 */
import { execFile, spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'

const SF_DATALESS = 0x40000000

/** A cloud placeholder whose bytes are not on disk (SF_DATALESS). Cheap: only zero-block files are asked about. */
export async function isOnlineOnly(path: string): Promise<boolean> {
  const st = await fsp.lstat(path).catch(() => null)
  if (!st || !st.isFile() || st.size === 0 || st.blocks > 0) return false
  return new Promise((resolve) =>
    execFile('/usr/bin/stat', ['-f', '%Xf', '--', path], { timeout: 3000 }, (err, out) => resolve(err ? true : (parseInt(String(out).trim(), 16) & SF_DATALESS) !== 0))
  )
}

export type DownloadOptions = { timeoutMs: number; signal?: AbortSignal }

const abortError = (): Error => Object.assign(new Error('stopped'), { code: 'ABORT_ERR' })

/**
 * Download one online-only file by reading it in a child process. Resolves when the read finished;
 * rejects with code ETIMEDOUT (no download within `timeoutMs`), ABORT_ERR (Stop), ENOTREG (not a
 * regular file: never handed to the child) or EDOWNLOAD (the read failed, e.g. offline).
 */
export async function downloadOnlineOnly(path: string, opts: DownloadOptions): Promise<void> {
  if (opts.signal?.aborted) throw abortError()
  const st = await fsp.lstat(path)
  if (!st.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'ENOTREG' })
  await new Promise<void>((resolve, reject) => {
    // stdin/stdout/stderr all /dev/null: nothing of the file reaches this process
    const child = spawn('/bin/cat', ['--', path], { stdio: 'ignore' })
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
    const timer = setTimeout(
      () => finish(Object.assign(new Error(`not downloaded within ${Math.round(opts.timeoutMs / 1000)} s`), { code: 'ETIMEDOUT' })),
      opts.timeoutMs
    )
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (e) => finish(Object.assign(new Error(`download failed: ${e.message}`), { code: 'EDOWNLOAD' })))
    child.on('exit', (code) => finish(code === 0 ? null : Object.assign(new Error('download failed (offline, or the file is unavailable)'), { code: 'EDOWNLOAD' })))
  })
}

/**
 * Run one download under a deadline and Stop, whatever the downloader does: rejects ETIMEDOUT after
 * `timeoutMs` and ABORT_ERR on Stop, and in both cases aborts the signal it handed the downloader
 * (the default downloader kills its child on that). Used by the backlog import and the capture scan.
 */
export function downloadWithDeadline(
  path: string,
  download: (path: string, opts: DownloadOptions) => Promise<void>,
  opts: DownloadOptions
): Promise<void> {
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
    const timer = setTimeout(
      () => finish(Object.assign(new Error(`not downloaded within ${Math.round(opts.timeoutMs / 1000)} s`), { code: 'ETIMEDOUT' })),
      opts.timeoutMs
    )
    opts.signal?.addEventListener('abort', onStop, { once: true })
    Promise.resolve()
      .then(() => download(path, { timeoutMs: opts.timeoutMs, signal: inner.signal }))
      .then(
      () => finish(null),
      (e) => finish(e instanceof Error ? e : new Error(String(e)))
    )
  })
}
