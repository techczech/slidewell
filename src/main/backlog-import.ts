/**
 * Execution layer for the one-off screenshot backlog import (ticket 13). COPY ONLY: originals on the
 * Desktop and in CleanShot's history are only read, never moved, changed or removed. Small interface:
 *   listBacklog(env)  → read-only listings (names, sizes, mtimes, online-only / not-regular flags)
 *   dryRun(env)       → the plan (backlog-plan.ts); writes nothing anywhere
 *   runImport(plan, env, opts) → stage → verify → link into place, with a ledger and a log
 *
 * Placement of one copy:
 *   1. `<watched>/.slidewell-staging/` must be a real directory directly inside the watched folder;
 *      created without following links and lstat-verified on every use (never cached).
 *   2. The staged file is created O_CREAT|O_EXCL|O_NOFOLLOW, written while the source is hashed in the
 *      same pass, fsynced, then re-read and re-hashed; both hashes must equal the source hash.
 *   3. `link(staged, final)`: refuses to replace (EEXIST → next collision name). Where hard links are
 *      unavailable (ENOTSUP / EPERM / EXDEV) `copyFile(staged, final, COPYFILE_EXCL)` instead, which
 *      also never replaces. Plain rename onto a final name is never used.
 *   4. The final file is lstat-checked and re-hashed. Only then is the staged name unlinked, after an
 *      identity check (same dev + inode as the file this call created). On a mismatch the staged file
 *      is kept and the final file is left as it is.
 *
 * Threat model: this defends against accidental concurrent activity (OneDrive sync, CleanShot
 * writing, the user editing or adding files), not against a hostile process of the same user racing
 * our private staging folder. Unlinking our own staged file inside that dot folder after an identity
 * check is therefore acceptable; it is the only unlink this module performs.
 *
 * Resume: a JSONL ledger (fsynced per line, in SlideWell's own data folder; a torn tail is followed by
 * a fresh line) keyed by content hash per watched folder. "Already copied" always means a ledger
 * entry whose recorded copy still exists, is a regular file and matches by hash. A recorded copy that
 * is online-only is reported as unverified and neither hydrated nor copied again. A final name that
 * exists with different content is a collision (the copy takes the next name); it is never removed,
 * and if it is smaller than the source it is logged as a possible incomplete copy.
 *
 * Reads: every source and destination is opened O_RDONLY|O_NOFOLLOW|O_NONBLOCK and fstat-checked to be
 * a regular file before a byte is read (FIFOs, sockets and devices are skipped and counted); online-only
 * placeholders (SF_DATALESS) are never opened in this process; every read has an idle timeout and stops
 * on cancel.
 *
 * Online-only SOURCES (ticket 15; reverses the earlier "never hydrate" rule for the Desktop and CleanShot
 * history only): one at a time, the file is downloaded by a child process (online-only.ts) with a
 * per-file timeout (default 120 s) and Stop, then re-checked; only once its bytes are on disk is it read
 * and copied as above. A file that does not arrive in time is left out and reported; the next run tries
 * again. Recorded copies in the watched folder are still never downloaded.
 * Remaining limit: a read already blocked inside a libuv worker (a hung network or File Provider read)
 * cannot be interrupted. We stop waiting for it (timeout or Stop rejects), but that worker stays busy
 * until the OS returns.
 */
import { createHash, randomBytes } from 'node:crypto'
import { constants as FS, promises as fsp, realpath as realpathCb } from 'node:fs'
import { promisify } from 'node:util'
import { join, basename } from 'node:path'
import { downloadOnlineOnly, downloadWithDeadline, isOnlineOnly, type DownloadOptions } from './online-only'
import type { NameTemplate } from './screenshot-name'
import { alternativeName, copyStateKey, foldersOverlap, planBacklogImport, parseLedger, STAGING_DIR, type BacklogPlan, type CopyState, type LedgerEntry, type ListedFile, type PlanItem } from './backlog-plan'

export type BacklogEnv = {
  desktopDir: string
  cleanshotDir: string | null // CleanShot's history media folder; null when absent
  watchedFolder: string | null
  stateDir: string // ledger + logs (SlideWell's own data folder, not the watched folder)
  now?: () => Date
  /** Filesystem calls; only tests pass these (backlog-ipc.ts never does). */
  ops?: Partial<FsOps>
  retry?: { tries?: number; baseMs?: number }
  readIdleMs?: number // a read that delivers no data for this long fails (default 30 s)
  downloadTimeoutMs?: number // an online-only source not downloaded within this is left out (default 120 s)
  nameTemplate?: NameTemplate | null // CleanShot's own name template, for recognising Desktop names
}

export type FsOps = {
  link: (from: string, to: string) => Promise<void>
  copyFileExcl: (from: string, to: string) => Promise<void>
  isOnlineOnly: (path: string) => Promise<boolean>
  /** Download one online-only source (out of process); honours opts.timeoutMs and opts.signal. */
  download: (path: string, opts: DownloadOptions) => Promise<void>
  stagedName: (stagingDir: string, name: string) => string
  /** Test seam: called with each chunk read from a source while staging it. */
  onSourceChunk?: (from: string, chunk: Buffer) => Promise<void> | void
}

export type RunProgress = { done: number; total: number; name: string }
export type RunResult = {
  ok: boolean
  cancelled: boolean
  copied: number // new verified copies written
  reused: number // identical file already in the watched folder under that name
  alreadyDone: number // the ledger's recorded copy still exists and matches
  downloaded: number // online-only sources downloaded during this run (then copied as usual)
  unverifiedOnlineOnly: number // recorded copy is online-only: not checked, not copied again
  onlineOnly: number // left out: online-only source not downloaded in time, or the name is taken by an online-only file
  notRegular: number // skipped: not a regular file
  gone: number // file vanished since the plan
  failed: number
  desktopWithCopy: number // Desktop originals that now have a verified copy (they stay on the Desktop)
  logPath: string
  errors: string[]
}

const RETRY_CODES = new Set(['EDEADLK', 'EAGAIN', 'EBUSY'])
const LINK_UNAVAILABLE = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'])
const DOWNLOAD_TIMEOUT_MS = 120_000
const ONLINE_ONLY_NOTE = 'online-only; open OneDrive (or iCloud) to download it, then run again'

class Skip extends Error {
  constructor(
    message: string,
    readonly kind: 'online-only' | 'not-regular' | 'unverified-online-only'
  ) {
    super(message)
  }
}
const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException)?.code
const abortError = (): Error => Object.assign(new Error('stopped'), { code: 'ABORT_ERR' })
const notRegular = (p: string): Error => Object.assign(new Error(`not a regular file: ${basename(p)}`), { code: 'ENOTREG' })

export function ledgerPath(stateDir: string): string {
  return join(stateDir, 'backlog-ledger.jsonl')
}

export function localDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** A cloud placeholder whose bytes are not on disk (SF_DATALESS); see online-only.ts. */
export const defaultIsOnlineOnly = isOnlineOnly

const defaultOps: FsOps = {
  link: (a, b) => fsp.link(a, b),
  copyFileExcl: (a, b) => fsp.copyFile(a, b, FS.COPYFILE_EXCL),
  isOnlineOnly: defaultIsOnlineOnly,
  download: downloadOnlineOnly,
  stagedName: (dir, name) => join(dir, `${name}.${randomBytes(8).toString('hex')}`)
}

async function withRetry<T>(fn: () => Promise<T>, env: BacklogEnv): Promise<T> {
  const tries = env.retry?.tries ?? 6
  const base = env.retry?.baseMs ?? 100
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      const code = errCode(e)
      if (!code || !RETRY_CODES.has(code) || i >= tries - 1) throw e
      await new Promise((r) => setTimeout(r, base * 2 ** i))
    }
  }
}

/**
 * Open a regular file without following links or blocking on FIFOs, then stream it through `onChunk`
 * with an idle timeout and cancellation. Resolves with the sha256 of the bytes read.
 */
export async function readHashed(path: string, opts: { idleMs?: number; signal?: AbortSignal; onChunk?: (c: Buffer) => Promise<unknown> | void } = {}): Promise<string> {
  if (opts.signal?.aborted) throw abortError()
  let fh: fsp.FileHandle
  try {
    fh = await fsp.open(path, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK)
  } catch (e) {
    if (errCode(e) === 'ELOOP') throw notRegular(path)
    throw e
  }
  const st = await fh.stat().catch(async (e) => {
    await fh.close()
    throw e
  })
  if (!st.isFile()) {
    await fh.close()
    throw notRegular(path)
  }
  const idleMs = opts.idleMs ?? 30_000
  return new Promise<string>((resolve, reject) => {
    const h = createHash('sha256')
    const rs = fh.createReadStream({ autoClose: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (err: Error | null, digest?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (err) {
        rs.destroy()
        reject(err)
      } else resolve(digest!)
    }
    const onAbort = (): void => finish(abortError())
    const arm = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => finish(Object.assign(new Error(`read stalled for ${Math.round(idleMs / 1000)} s`), { code: 'ETIMEDOUT' })), idleMs)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    arm()
    rs.on('data', (chunk) => {
      const b = chunk as Buffer
      h.update(b)
      const p = opts.onChunk?.(b)
      if (p && typeof (p as Promise<unknown>).then === 'function') {
        rs.pause()
        ;(p as Promise<unknown>).then(
          () => {
            if (settled) return
            arm()
            rs.resume()
          },
          (e) => finish(e as Error)
        )
      } else arm()
    })
    rs.on('error', (e) => finish(e))
    rs.on('end', () => finish(null, h.digest('hex')))
  })
}

// ---------- listing (read-only) ----------

async function listFiles(root: string, depth: 1 | 2, ops: FsOps): Promise<ListedFile[]> {
  const out: ListedFile[] = []
  const visit = async (dir: string, rel: string, level: number): Promise<void> => {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      const abs = join(dir, e.name)
      if (e.isDirectory()) {
        if (level < depth) await visit(abs, r, level + 1)
        else out.push({ rel: `${r}/…`, size: 0, mtimeMs: 0 }) // deeper content (bundles) — counted as skipped, never read
        continue
      }
      if (e.isSymbolicLink()) continue // links are never followed
      try {
        const st = await fsp.lstat(abs)
        if (!st.isFile()) out.push({ rel: r, size: st.size, mtimeMs: Math.round(st.mtimeMs), notRegular: true })
        else out.push({ rel: r, size: st.size, mtimeMs: Math.round(st.mtimeMs), ...((await ops.isOnlineOnly(abs)) ? { onlineOnly: true } : {}) })
      } catch {
        /* vanished */
      }
    }
  }
  await visit(root, '', 1)
  return out
}

async function readLedger(stateDir: string): Promise<LedgerEntry[]> {
  try {
    return parseLedger(await fsp.readFile(ledgerPath(stateDir), 'utf8'))
  } catch {
    return []
  }
}

const realpathNative = promisify(realpathCb.native)
/** Canonical path (symlinks and aliases resolved), or null when missing. */
export const real = async (p: string | null): Promise<string | null> => (p ? realpathNative(p).catch(() => null) : null)

/** Desktop, CleanShot history and watched folder by realpath (null when missing). */
export async function resolveFolders(env: BacklogEnv): Promise<{ desktop: string | null; cleanshot: string | null; watched: string | null }> {
  const [desktop, cleanshot, watched] = await Promise.all([real(env.desktopDir), real(env.cleanshotDir), real(env.watchedFolder)])
  return { desktop, cleanshot, watched }
}

/** State of a recorded copy: never opens an online-only or non-regular file. */
async function copyState(path: string, hash: string, env: BacklogEnv, ops: FsOps, signal?: AbortSignal): Promise<CopyState> {
  const st = await fsp.lstat(path).catch(() => null)
  if (!st || !st.isFile()) return 'missing-or-changed'
  if (await ops.isOnlineOnly(path)) return 'online-only'
  // a stalled or failed read propagates (it must not look "missing", which would copy it again)
  const h = await withRetry(() => readHashed(path, { idleMs: env.readIdleMs, signal }), env).catch((e) => {
    if (errCode(e) === 'ENOTREG') return null
    throw e
  })
  return h === hash ? 'ok' : 'missing-or-changed'
}

export async function listBacklog(env: BacklogEnv): Promise<{ desktop: ListedFile[]; cleanshot: ListedFile[]; watchedNames: string[]; stagingNames: string[] }> {
  const ops = { ...defaultOps, ...env.ops }
  const dirs = await resolveFolders(env)
  const desktop = dirs.desktop ? await listFiles(dirs.desktop, 1, ops) : []
  const cleanshot = dirs.cleanshot ? await listFiles(dirs.cleanshot, 2, ops) : []
  const watchedNames = dirs.watched ? await fsp.readdir(dirs.watched).catch(() => []) : []
  let stagingNames: string[] = []
  if (dirs.watched) {
    const s = join(dirs.watched, STAGING_DIR)
    const st = await fsp.lstat(s).catch(() => null)
    if (st?.isDirectory()) stagingNames = await fsp.readdir(s).catch(() => [])
  }
  // folders below the listing depth appear as `<rel>/…` markers: ignored on the Desktop, counted as skipped in CleanShot
  return { desktop: desktop.filter((f) => !f.rel.endsWith('/…')), cleanshot, watchedNames, stagingNames }
}

/**
 * The dry run: listings + ledger + the state of each recorded copy → plan, all folders by realpath.
 * Writes nothing (no state folder, no log). Reads recorded copies to check them; never online-only ones.
 */
export async function dryRun(env: BacklogEnv): Promise<BacklogPlan> {
  const ops = { ...defaultOps, ...env.ops }
  const dirs = await resolveFolders(env)
  const l = await listBacklog(env)
  const ledger = (await readLedger(env.stateDir)).filter((e) => e.watched === dirs.watched)
  const copyStates: Record<string, CopyState> = {}
  for (const e of ledger) {
    const k = copyStateKey(e.dest, e.hash)
    if (k in copyStates) continue
    copyStates[k] = await copyState(e.dest, e.hash, env, ops).catch(() => 'missing-or-changed' as const) // the run re-checks and fails that item if the read fails again
  }
  return planBacklogImport({
    watchedFolder: dirs.watched,
    desktopDir: dirs.desktop ?? env.desktopDir,
    cleanshotDir: dirs.cleanshot,
    desktop: l.desktop,
    cleanshot: l.cleanshot,
    watchedNames: l.watchedNames,
    stagingNames: l.stagingNames,
    ledger,
    copyStates,
    nameTemplate: env.nameTemplate,
    date: localDate((env.now ?? (() => new Date()))())
  })
}

// ---------- writing ----------

/** Append one JSON line, fsynced. If the file ends in a torn line, a newline is written first so this record starts clean. */
async function appendLine(path: string, obj: unknown, env: BacklogEnv): Promise<void> {
  await withRetry(async () => {
    const fh = await fsp.open(path, 'a+')
    try {
      const { size } = await fh.stat()
      let lead = ''
      if (size > 0) {
        const b = Buffer.alloc(1)
        await fh.read(b, 0, 1, size - 1)
        if (b[0] !== 0x0a) lead = '\n'
      }
      await fh.write(`${lead}${JSON.stringify(obj)}\n`)
      await fh.sync()
    } finally {
      await fh.close()
    }
  }, env)
}

type Staged = { path: string; ino: number; dev: number }

export async function runImport(
  plan: BacklogPlan,
  env: BacklogEnv,
  opts: { onProgress?: (p: RunProgress) => void; signal?: AbortSignal } = {}
): Promise<RunResult> {
  const now = env.now ?? (() => new Date())
  await fsp.mkdir(join(env.stateDir, 'logs'), { recursive: true })
  const logPath = join(env.stateDir, 'logs', `backlog-import-${now().toISOString().replace(/[:.]/g, '-')}.jsonl`)
  const res: RunResult = {
    ok: false,
    cancelled: false,
    copied: 0,
    reused: 0,
    alreadyDone: 0,
    downloaded: 0,
    unverifiedOnlineOnly: 0,
    onlineOnly: 0,
    notRegular: 0,
    gone: 0,
    failed: 0,
    desktopWithCopy: 0,
    logPath,
    errors: []
  }
  const log = (event: string, extra: Record<string, unknown> = {}): Promise<void> => appendLine(logPath, { at: now().toISOString(), event, ...extra }, env)
  if (!plan.ok) {
    await log('refused', { reason: plan.reason })
    return res
  }
  const ops: FsOps = { ...defaultOps, ...env.ops }
  const signal = opts.signal
  const hashOf = (p: string): Promise<string> => withRetry(() => readHashed(p, { idleMs: env.readIdleMs, signal }), env)

  // Run-time folder guard: same watched folder as the plan (by realpath), no overlap with the sources.
  const dirs = await resolveFolders(env)
  const refuse = async (why: string): Promise<RunResult> => {
    res.errors.push(why)
    await log('refused', { reason: why })
    return res
  }
  if (!dirs.watched || dirs.watched !== plan.watchedFolder) return refuse('the watched folder changed since the plan was shown; review again')
  for (const other of [dirs.desktop, dirs.cleanshot]) if (other && foldersOverlap(dirs.watched, other)) return refuse('the watched folder overlaps the Desktop or CleanShot history')
  const watched = dirs.watched
  const ledgerFile = ledgerPath(env.stateDir)

  /** The private staging folder, checked on every use: a real directory directly inside `watched`. */
  const stagingDir = async (): Promise<string> => {
    const s = join(watched, STAGING_DIR)
    if (!(await fsp.lstat(s).catch(() => null))) await withRetry(() => fsp.mkdir(s), env).catch((e) => (errCode(e) === 'EEXIST' ? undefined : Promise.reject(e)))
    const st = await fsp.lstat(s)
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('the staging folder is not a real folder (a link or a file has its name)')
    if ((await real(s)) !== s) throw new Error('the staging folder resolves outside the watched folder')
    return s
  }

  /**
   * "Already brought in": any ledger entry for this content hash (a done record or a placing intent,
   * from any source item and under any name) whose recorded path still exists and matches.
   * `unrecorded` = only an intent vouches for it (crash between link and the done record).
   */
  const priorState = async (hash: string): Promise<{ state: 'ok' | 'online-only' | 'none'; dest: string; unrecorded: boolean; unresolved: Set<string> }> => {
    const entries = (await readLedger(env.stateDir)).filter((e) => e.watched === watched && e.hash === hash).reverse()
    const done = new Set(entries.filter((e) => e.step === 'copied').map((e) => e.dest))
    const checked = new Set<string>()
    let online: string | null = null
    const unresolved = new Set<string>() // intent-only paths that are online-only: never read, never reused
    for (const e of entries) {
      if (checked.has(e.dest)) continue
      checked.add(e.dest)
      const s = await copyState(e.dest, hash, env, ops, signal)
      if (s === 'ok') return { state: 'ok', dest: e.dest, unrecorded: !done.has(e.dest), unresolved }
      if (s === 'online-only') {
        if (done.has(e.dest)) online ??= e.dest // only a real earlier copy is "unverified, online-only"
        else unresolved.add(e.dest)
      }
    }
    return online ? { state: 'online-only', dest: online, unrecorded: false, unresolved } : { state: 'none', dest: '', unrecorded: false, unresolved }
  }

  /** Stage `from`: exclusive create, write while hashing the source, fsync, re-hash the staged bytes. */
  const stage = async (from: string, name: string, hash: string): Promise<Staged> =>
    withRetry(async () => {
      const path = ops.stagedName(await stagingDir(), name)
      const fh = await fsp.open(path, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o644)
      const st = await fh.stat()
      const staged: Staged = { path, ino: st.ino, dev: st.dev }
      let read: string
      try {
        read = await readHashed(from, {
          idleMs: env.readIdleMs,
          signal,
          onChunk: async (c) => {
            await ops.onSourceChunk?.(from, c)
            await fh.write(c)
          }
        })
        await fh.sync()
      } finally {
        await fh.close()
      }
      if (read !== hash) throw Object.assign(new Error('the original changed while copying'), { code: 'ECHANGED', staged })
      if ((await hashOf(path)) !== hash) throw Object.assign(new Error('the staged copy did not verify'), { code: 'ESTAGED', staged })
      return staged
    }, env)

  /** Unlink our own staged file, only if it is still the file we created (see the threat model). */
  const dropStaged = async (s: Staged): Promise<void> => {
    const st = await fsp.lstat(s.path).catch(() => null)
    if (st && st.isFile() && st.ino === s.ino && st.dev === s.dev) await fsp.unlink(s.path)
  }

  /** Put a verified copy of `from` into `watched` under `name` or the next free collision name. */
  const placeCopy = async (item: PlanItem, hash: string, size: number, mtimeMs: number, unresolved: Set<string>): Promise<{ dest: string; reused: boolean }> => {
    let staged: Staged | null = null
    for (let n = 1; n < 1000; n++) {
      const target = join(watched, n === 1 ? item.name : alternativeName(item.name, n))
      const existing = await fsp.lstat(target).catch(() => null)
      if (existing) {
        if (!existing.isFile()) continue // a link, folder or special file: never followed, never opened
        if (unresolved.has(target)) {
          await log('unresolved-online-only', { path: target }) // our own earlier attempt, online-only: not read, next name
          continue
        }
        if (await ops.isOnlineOnly(target)) throw new Skip(`the name ${basename(target)} is taken by a file that is ${ONLINE_ONLY_NOTE}`, 'online-only')
        if ((await hashOf(target)) === hash) return { dest: target, reused: true } // a staged file from an earlier attempt, if any, is kept
        if (existing.size < size) await log('possible-incomplete-copy', { path: target, size: existing.size, expected: size })
        else await log('name-taken', { path: target })
        continue
      }
      staged ??= await stage(item.from, item.name, hash)
      // intent first (fsynced): if we die after the link, a resume finds this content at `target`
      await appendLine(ledgerFile, { step: 'placing', hash, watched, source: item.source, from: item.from, size, mtimeMs, dest: target, at: now().toISOString() } satisfies LedgerEntry, env)
      try {
        await withRetry(() => ops.link(staged!.path, target), env)
      } catch (e) {
        const code = errCode(e)
        if (code === 'EEXIST') continue
        if (!LINK_UNAVAILABLE.has(code ?? '')) throw e
        try {
          await withRetry(() => ops.copyFileExcl(staged!.path, target), env)
        } catch (e2) {
          if (errCode(e2) === 'EEXIST') continue
          throw e2
        }
      }
      const fin = await fsp.lstat(target)
      if (!fin.isFile() || (await hashOf(target)) !== hash) throw new Error(`copy did not verify (${basename(target)}); staged file kept`)
      await dropStaged(staged)
      return { dest: target, reused: false }
    }
    throw new Error(`no free name for ${item.name}`)
  }

  await log('start', { watched, items: plan.items.length, desktop: plan.summary.desktop.count, cleanshot: plan.summary.cleanshot.count })
  const total = plan.items.length
  let done = 0
  for (const item of plan.items) {
    opts.onProgress?.({ done, total, name: item.name })
    if (signal?.aborted) {
      res.cancelled = true
      break
    }
    try {
      await importOne(item)
    } catch (e) {
      if (signal?.aborted && errCode(e) === 'ABORT_ERR') {
        res.cancelled = true
        await log('stopped-mid-item', { source: item.source, from: item.from })
        break
      }
      const kind = e instanceof Skip ? e.kind : errCode(e) === 'ENOTREG' ? 'not-regular' : null
      if (kind === 'online-only') res.onlineOnly++
      else if (kind === 'not-regular') res.notRegular++
      else if (kind === 'unverified-online-only') res.unverifiedOnlineOnly++
      else {
        res.failed++
        res.errors.push(`${item.name}: ${(e as Error).message}`)
      }
      await log(kind ?? 'failed', { source: item.source, from: item.from, reason: (e as Error).message }).catch(() => undefined)
    }
    done++
  }
  opts.onProgress?.({ done, total, name: '' })
  res.ok = !res.cancelled && res.failed === 0
  await log(res.cancelled ? 'cancelled' : 'finished', { ...res, errors: undefined, logPath: undefined })
  return res

  async function importOne(item: PlanItem): Promise<void> {
    let st = await withRetry(() => fsp.lstat(item.from), env).catch(() => null)
    if (!st) {
      res.gone++
      await log('gone', { source: item.source, from: item.from })
      return
    }
    if (!st.isFile()) throw new Skip('not a regular file', 'not-regular')
    if (await ops.isOnlineOnly(item.from)) {
      await downloadSource(item)
      st = await withRetry(() => fsp.lstat(item.from), env)
      if (!st.isFile()) throw new Skip('not a regular file', 'not-regular')
    }
    const hash = await hashOf(item.from)

    const prior = await priorState(hash)
    if (prior.state === 'ok') {
      if (prior.unrecorded) {
        const done: LedgerEntry = { step: 'copied', hash, watched, source: item.source, from: item.from, size: st.size, mtimeMs: Math.round(st.mtimeMs), dest: prior.dest, at: now().toISOString() }
        await appendLine(ledgerFile, done, env)
        await log('intent-confirmed', { source: item.source, from: item.from, hash, dest: prior.dest })
      }
      res.alreadyDone++
      if (item.source === 'desktop') res.desktopWithCopy++
      await log('already-done', { source: item.source, from: item.from, hash, dest: prior.dest })
      return
    }
    if (prior.state === 'online-only') throw new Skip(`the earlier copy ${basename(prior.dest)} is ${ONLINE_ONLY_NOTE}; not checked, not copied again`, 'unverified-online-only')

    const placed = await placeCopy(item, hash, st.size, Math.round(st.mtimeMs), prior.unresolved)
    if (placed.reused) res.reused++
    else res.copied++
    if (item.source === 'desktop') res.desktopWithCopy++
    const entry: LedgerEntry = { step: 'copied', hash, watched, source: item.source, from: item.from, size: st.size, mtimeMs: Math.round(st.mtimeMs), dest: placed.dest, at: now().toISOString() }
    await appendLine(ledgerFile, entry, env)
    await log(placed.reused ? 'reused' : 'copied', { source: item.source, from: item.from, to: placed.dest, hash, verified: true })
  }

  /** Online-only source: download it out of process (timeout + Stop), then insist its bytes are on disk. */
  async function downloadSource(item: PlanItem): Promise<void> {
    const timeoutMs = env.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS
    await log('downloading', { source: item.source, from: item.from, size: item.size })
    try {
      await downloadWithDeadline(item.from, ops.download, { timeoutMs, signal })
    } catch (e) {
      const code = errCode(e)
      if (code === 'ABORT_ERR') throw e
      if (code === 'ENOTREG') throw new Skip('not a regular file', 'not-regular')
      throw new Skip(`online-only, ${(e as Error).message}; left out, run again to retry`, 'online-only')
    }
    if (await ops.isOnlineOnly(item.from)) throw new Skip('online-only, still not downloaded after reading it; left out, run again to retry', 'online-only')
    res.downloaded++
    await log('downloaded', { source: item.source, from: item.from })
  }
}

