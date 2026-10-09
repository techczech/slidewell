/**
 * Execution layer for the one-off screenshot backlog import (ticket 13). Small interface:
 *   listBacklog(env)  → read-only listings (names, sizes, mtimes, online-only flag); never opens a file
 *   dryRun(env)       → the plan (backlog-plan.ts); writes nothing anywhere
 *   runImport(plan, env, opts) → copy → verify → move, with a ledger and a log
 *
 * Safety rules this module holds:
 * - Nothing is deleted. CleanShot's history is only read. A Desktop original is moved into
 *   `Moved by SlideWell <date>` only after a hash-verified copy exists, and only if, right before the
 *   move, the original is still the same file (dev, ino, size, mtime, hash) and the copy still verifies.
 *   A move is link(2) to the new name then removal of the old name (same inode, so the content is
 *   never without a name); across volumes it is skipped and logged, never emulated by copy+delete.
 *   The only file this module ever unlinks by itself is a temp file it created in the same call,
 *   checked by inode first.
 * - Nothing is replaced. Every placement uses a primitive that fails on an existing name: link(2),
 *   or where hard links are unsupported, an O_EXCL reservation that only our own empty placeholder
 *   can be renamed over. On EEXIST the next collision name is tried. Temp files are created with
 *   O_EXCL|O_NOFOLLOW under a random name.
 * - Folders are compared by realpath (aliases and symlinks cannot defeat the overlap guard), at plan
 *   time and again at run time. The dated moved folder must be a real directory directly inside the
 *   watched folder.
 * - OneDrive: EDEADLK / EAGAIN / EBUSY are retried with backoff; online-only placeholders are never
 *   read (they would trigger a download and can stall); every read has an idle timeout and stops
 *   on cancel. No watcher events drive the run.
 * - Resume: a JSONL ledger (fsynced per line, in SlideWell's own data folder, torn tails repaired by
 *   starting a fresh line) keyed by content hash per watched folder. "Already copied" always means a
 *   ledger entry whose recorded copy still exists and matches by hash.
 */
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants as FS, createReadStream, promises as fsp, realpath as realpathCb, type Stats } from 'node:fs'
import { promisify } from 'node:util'
import { join, dirname, basename } from 'node:path'
import { alternativeName, foldersOverlap, PARTIAL_SUFFIX, planBacklogImport, parseLedger, type BacklogPlan, type LedgerEntry, type ListedFile, type PlanItem } from './backlog-plan'

export type BacklogEnv = {
  desktopDir: string
  cleanshotDir: string | null // CleanShot's history media folder; null when absent
  watchedFolder: string | null
  stateDir: string // ledger + logs (SlideWell's own data folder, not the watched folder)
  now?: () => Date
  /** Filesystem calls the run makes; tests inject faults and races here. */
  ops?: Partial<FsOps>
  /** Test seam: called just before the pre-move checks of a Desktop item. */
  hooks?: { beforeMoveCheck?: (item: PlanItem) => void | Promise<void> }
  retry?: { tries?: number; baseMs?: number }
  readIdleMs?: number // a read that delivers no data for this long fails (default 30 s)
}

export type FsOps = {
  link: (from: string, to: string) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  isOnlineOnly: (path: string) => Promise<boolean>
  tempName: (target: string) => string
}

export type RunProgress = { done: number; total: number; name: string }
export type RunResult = {
  ok: boolean
  cancelled: boolean
  copied: number // new verified copies written
  reused: number // identical file already in the watched folder (same name, same hash)
  alreadyDone: number // the ledger's recorded copy still exists and matches
  moved: number // Desktop originals moved
  moveSkipped: number // Desktop originals left in place (changed, copy missing, cross-volume…), logged
  onlineOnly: number // left out: online-only placeholders (source, existing name or recorded copy)
  gone: number // file vanished since the plan
  failed: number
  logPath: string
  errors: string[]
}

const RETRY_CODES = new Set(['EDEADLK', 'EAGAIN', 'EBUSY'])
const LINK_UNSUPPORTED = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EMLINK'])
const SF_DATALESS = 0x40000000
const ONLINE_ONLY_NOTE = 'online-only; open OneDrive (or iCloud) to download it, then run again'

class SkipItem extends Error {
  constructor(
    message: string,
    readonly kind: 'online-only' | 'move'
  ) {
    super(message)
  }
}
const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException)?.code
const abortError = (): Error => Object.assign(new Error('stopped'), { code: 'ABORT_ERR' })

export function ledgerPath(stateDir: string): string {
  return join(stateDir, 'backlog-ledger.jsonl')
}

export function localDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** A cloud placeholder whose bytes are not on disk (SF_DATALESS). Cheap: only zero-block files are asked about. */
export async function defaultIsOnlineOnly(path: string): Promise<boolean> {
  const st = await fsp.lstat(path).catch(() => null)
  if (!st || !st.isFile() || st.size === 0 || st.blocks > 0) return false
  return new Promise((resolve) =>
    execFile('/usr/bin/stat', ['-f', '%Xf', '--', path], { timeout: 3000 }, (err, out) => resolve(err ? true : (parseInt(String(out).trim(), 16) & SF_DATALESS) !== 0))
  )
}

const defaultOps: FsOps = {
  link: (a, b) => fsp.link(a, b),
  rename: (a, b) => fsp.rename(a, b),
  isOnlineOnly: defaultIsOnlineOnly,
  tempName: (target) => join(dirname(target), `.${basename(target)}.${randomBytes(8).toString('hex')}${PARTIAL_SUFFIX}`)
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
 * Stream a file through `onChunk` with an idle timeout and cancellation; resolves with its sha256.
 * `onChunk` may return a promise (back-pressure: reading pauses until it settles).
 */
export function readHashed(path: string, opts: { idleMs?: number; signal?: AbortSignal; onChunk?: (c: Buffer) => Promise<unknown> | void } = {}): Promise<string> {
  const idleMs = opts.idleMs ?? 30_000
  return new Promise<string>((resolve, reject) => {
    const h = createHash('sha256')
    const rs = createReadStream(path)
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
    if (opts.signal?.aborted) return finish(abortError())
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    arm()
    rs.on('data', (chunk) => {
      arm()
      const b = chunk as Buffer
      h.update(b)
      const p = opts.onChunk?.(b)
      if (p && typeof (p as Promise<unknown>).then === 'function') {
        rs.pause()
        ;(p as Promise<unknown>).then(
          () => settled || rs.resume(),
          (e) => finish(e as Error)
        )
      }
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
      if (e.isFile()) {
        try {
          const st = await fsp.lstat(abs)
          if (st.isFile()) out.push({ rel: r, size: st.size, mtimeMs: Math.round(st.mtimeMs), ...((await ops.isOnlineOnly(abs)) ? { onlineOnly: true } : {}) })
        } catch {
          /* vanished */
        }
      } else if (e.isDirectory()) {
        if (level < depth) await visit(abs, r, level + 1)
        else out.push({ rel: `${r}/…`, size: 0, mtimeMs: 0 }) // deeper content (bundles) — counted as skipped, never read
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

export async function listBacklog(env: BacklogEnv): Promise<{ desktop: ListedFile[]; cleanshot: ListedFile[]; watchedNames: string[] }> {
  const ops = { ...defaultOps, ...env.ops }
  const dirs = await resolveFolders(env)
  const desktop = dirs.desktop ? await listFiles(dirs.desktop, 1, ops) : []
  const cleanshot = dirs.cleanshot ? await listFiles(dirs.cleanshot, 2, ops) : []
  const watchedNames = dirs.watched ? await fsp.readdir(dirs.watched).catch(() => []) : []
  // folders below the listing depth appear as `<rel>/…` markers: ignored on the Desktop, counted as skipped in CleanShot
  return { desktop: desktop.filter((f) => !f.rel.endsWith('/…')), cleanshot, watchedNames }
}

/** The dry run: listings + ledger → plan, all folders by realpath. Writes nothing (no state folder, no log). */
export async function dryRun(env: BacklogEnv): Promise<BacklogPlan> {
  const dirs = await resolveFolders(env)
  const l = await listBacklog(env)
  return planBacklogImport({
    watchedFolder: dirs.watched,
    desktopDir: dirs.desktop ?? env.desktopDir,
    cleanshotDir: dirs.cleanshot,
    desktop: l.desktop,
    cleanshot: l.cleanshot,
    watchedNames: l.watchedNames,
    ledger: await readLedger(env.stateDir),
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

type OwnTemp = { path: string; ino: number; dev: number }

/** Remove a temp file only if it is still the very file this call created. */
async function removeOwnTemp(t: OwnTemp): Promise<void> {
  const st = await fsp.lstat(t.path).catch(() => null)
  if (st && st.isFile() && st.ino === t.ino && st.dev === t.dev) await fsp.unlink(t.path).catch(() => undefined)
}

/**
 * Put `src` at `dest` without ever replacing an existing `dest`; afterwards `src`'s old name is gone
 * and its inode lives at `dest`. EEXIST and EXDEV propagate to the caller.
 */
async function placeNoReplace(src: string, dest: string, env: BacklogEnv, ops: FsOps): Promise<void> {
  const before = await fsp.lstat(src)
  try {
    await withRetry(() => ops.link(src, dest), env)
  } catch (e) {
    if (!LINK_UNSUPPORTED.has(errCode(e) ?? '')) throw e
    // No hard links here: reserve the name exclusively, then rename over our own empty placeholder only.
    const fh = await fsp.open(dest, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o644)
    const resv = await fh.stat()
    await fh.close()
    const nowSt = await fsp.lstat(dest)
    if (nowSt.ino !== resv.ino || nowSt.dev !== resv.dev || nowSt.size !== 0) throw Object.assign(new Error('reserved name was taken'), { code: 'EEXIST' })
    try {
      await withRetry(() => ops.rename(src, dest), env)
    } catch (err) {
      await removeOwnTemp({ path: dest, ino: resv.ino, dev: resv.dev }) // our own empty placeholder only
      throw err
    }
    return
  }
  const linked = await fsp.lstat(dest)
  if (linked.ino !== before.ino || linked.dev !== before.dev) throw new Error(`link check failed for ${basename(dest)}`) // both names left in place
  await withRetry(() => fsp.unlink(src), env) // the content stays under `dest` (same inode)
}

export async function runImport(
  plan: BacklogPlan,
  env: BacklogEnv,
  opts: { onProgress?: (p: RunProgress) => void; signal?: AbortSignal } = {}
): Promise<RunResult> {
  const now = env.now ?? (() => new Date())
  await fsp.mkdir(join(env.stateDir, 'logs'), { recursive: true })
  const logPath = join(env.stateDir, 'logs', `backlog-import-${now().toISOString().replace(/[:.]/g, '-')}.jsonl`)
  const res: RunResult = { ok: false, cancelled: false, copied: 0, reused: 0, alreadyDone: 0, moved: 0, moveSkipped: 0, onlineOnly: 0, gone: 0, failed: 0, logPath, errors: [] }
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
  if (dirname(plan.movedFolder) !== dirs.watched) return refuse('the moved folder is not inside the watched folder')

  const watched = dirs.watched
  const ledgerFile = ledgerPath(env.stateDir)

  // Moved folder: created without following links, then checked to be a real folder directly inside `watched`.
  let movedReady: Promise<string | null> | null = null
  const ensureMovedFolder = (): Promise<string | null> =>
    (movedReady ??= (async () => {
      const m = plan.movedFolder
      const pre = await fsp.lstat(m).catch(() => null)
      if (!pre) await withRetry(() => fsp.mkdir(m), env).catch((e) => (errCode(e) === 'EEXIST' ? undefined : Promise.reject(e)))
      const st = await fsp.lstat(m)
      if (st.isSymbolicLink() || !st.isDirectory()) return 'the moved folder is not a real folder (a link or a file has that name)'
      if (dirname((await real(m)) ?? '') !== watched) return 'the moved folder resolves outside the watched folder'
      return null
    })())

  /** Check a recorded or existing copy: 'ok', 'online-only' (exists, cannot be read without downloading), or 'bad'. */
  const checkCopy = async (path: string, hash: string): Promise<'ok' | 'online-only' | 'bad'> => {
    const st = await fsp.lstat(path).catch(() => null)
    if (!st || !st.isFile()) return 'bad'
    if (await ops.isOnlineOnly(path)) return 'online-only'
    return (await hashOf(path)) === hash ? 'ok' : 'bad'
  }

  /** "Already copied": a ledger entry for this content whose recorded copy still exists and matches. */
  const verifiedPrior = async (hash: string, size: number): Promise<{ dest: string; onlineOnly: boolean } | null> => {
    const entries = (await readLedger(env.stateDir)).filter((e) => e.watched === watched && e.step === 'copied' && e.hash === hash).reverse()
    for (const e of entries) {
      const c = await checkCopy(e.dest, hash)
      if (c === 'ok') return { dest: e.dest, onlineOnly: false }
      if (c === 'online-only' && (await fsp.lstat(e.dest)).size === size) return { dest: e.dest, onlineOnly: true }
    }
    return null
  }

  /** Put a verified copy of `from` into `watched` under `name` or the next free collision name. */
  const placeCopy = async (from: string, hash: string, name: string): Promise<{ dest: string; reused: boolean }> => {
    let temp: OwnTemp | null = null
    try {
      for (let n = 1; n < 1000; n++) {
        const target = join(watched, n === 1 ? name : alternativeName(name, n))
        const existing = await fsp.lstat(target).catch(() => null)
        if (existing) {
          if (!existing.isFile()) continue // a link or folder: never followed, never compared
          if (await ops.isOnlineOnly(target)) throw new SkipItem(`the name ${basename(target)} is taken by a file that is ${ONLINE_ONLY_NOTE}`, 'online-only')
          if ((await hashOf(target)) === hash) return { dest: target, reused: true }
          continue
        }
        temp ??= await writeTemp(from, target, hash)
        try {
          await placeNoReplace(temp.path, target, env, ops)
        } catch (e) {
          if (errCode(e) === 'EEXIST') continue // someone took the name meanwhile: try the next one
          throw e
        }
        temp = null // placed: the temp's inode now lives at `target`
        if ((await hashOf(target)) !== hash) throw new Error(`copy did not verify (${basename(target)})`) // left in place; never deleted
        return { dest: target, reused: false }
      }
      throw new Error(`no free name for ${name}`)
    } finally {
      if (temp) await removeOwnTemp(temp)
    }
  }

  /** Write `from` into an exclusively created temp next to `target`; fsync; check the bytes read match `hash`. */
  const writeTemp = async (from: string, target: string, hash: string): Promise<OwnTemp> =>
    withRetry(async () => {
      const path = ops.tempName(target)
      const fh = await fsp.open(path, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o644)
      const st = await fh.stat()
      const own: OwnTemp = { path, ino: st.ino, dev: st.dev }
      try {
        const got = await readHashed(from, { idleMs: env.readIdleMs, signal, onChunk: (c) => fh.write(c) })
        await fh.sync()
        if (got !== hash) throw Object.assign(new Error('the original changed while copying'), { code: 'ECHANGED' })
      } catch (e) {
        await fh.close().catch(() => undefined)
        await removeOwnTemp(own)
        throw e
      }
      await fh.close()
      return own
    }, env)

  /** Move a Desktop original into the moved folder under a free name, never replacing anything. */
  const moveOriginal = async (from: string, name: string): Promise<string> => {
    const bad = await ensureMovedFolder()
    if (bad) throw new SkipItem(bad, 'move')
    for (let n = 1; n < 1000; n++) {
      const to = join(plan.movedFolder, n === 1 ? name : alternativeName(name, n))
      try {
        await placeNoReplace(from, to, env, ops)
        return to
      } catch (e) {
        const code = errCode(e)
        if (code === 'EEXIST') continue
        if (code === 'EXDEV') throw new SkipItem('different volume; left on the Desktop', 'move')
        throw e
      }
    }
    throw new SkipItem('no free name in the moved folder', 'move')
  }

  await log('start', { watched, items: plan.items.length, desktop: plan.summary.desktop.count, cleanshot: plan.summary.cleanshot.count, pendingMoves: plan.summary.pendingMoves })
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
      if (e instanceof SkipItem) {
        if (e.kind === 'online-only') res.onlineOnly++
        else res.moveSkipped++
        await log(e.kind === 'online-only' ? 'online-only' : 'move-skipped', { source: item.source, from: item.from, reason: e.message })
      } else {
        res.failed++
        res.errors.push(`${item.name}: ${(e as Error).message}`)
        await log('failed', { source: item.source, from: item.from, error: (e as Error).message }).catch(() => undefined)
      }
    }
    done++
  }
  opts.onProgress?.({ done, total, name: '' })
  res.ok = !res.cancelled && res.failed === 0
  await log(res.cancelled ? 'cancelled' : 'finished', { ...res, errors: undefined, logPath: undefined })
  return res

  async function importOne(item: PlanItem): Promise<void> {
    const st = await withRetry(() => fsp.lstat(item.from), env).catch(() => null)
    if (!st || !st.isFile()) {
      res.gone++
      await log('gone', { source: item.source, from: item.from })
      return
    }
    if (await ops.isOnlineOnly(item.from)) throw new SkipItem(`this file is ${ONLINE_ONLY_NOTE}`, 'online-only')
    const hash = await hashOf(item.from)
    const record = (step: 'copied' | 'moved', dest: string, s: Stats = st): Promise<void> =>
      appendLine(ledgerFile, { step, hash, watched, source: item.source, from: item.from, size: s.size, mtimeMs: Math.round(s.mtimeMs), dest, at: now().toISOString() } satisfies LedgerEntry, env)

    // 1. a verified copy in the watched folder (a ledger entry alone is not enough)
    let copy: string
    const prior = await verifiedPrior(hash, st.size)
    if (prior) {
      copy = prior.dest
      res.alreadyDone++
      await log('already-done', { source: item.source, from: item.from, hash, dest: prior.dest, copyOnlineOnly: prior.onlineOnly || undefined })
    } else {
      const placed = await placeCopy(item.from, hash, item.name)
      copy = placed.dest
      if (placed.reused) res.reused++
      else res.copied++
      await record('copied', copy)
      await log(placed.reused ? 'reused' : 'copied', { source: item.source, from: item.from, to: copy, hash, verified: true })
    }

    // 2. Desktop only: move the original (never delete), after re-checking both files
    if (item.source !== 'desktop') return
    await env.hooks?.beforeMoveCheck?.(item)
    const again = await fsp.lstat(item.from).catch(() => null)
    if (!again || !again.isFile() || again.dev !== st.dev || again.ino !== st.ino || again.size !== st.size || again.mtimeMs !== st.mtimeMs)
      throw new SkipItem('the original changed or moved since it was copied; left where it is', 'move')
    if ((await hashOf(item.from)) !== hash) throw new SkipItem('the original changed since it was copied; left on the Desktop', 'move')
    const c = await checkCopy(copy, hash)
    if (c !== 'ok') throw new SkipItem(c === 'online-only' ? `the copy is ${ONLINE_ONLY_NOTE}; original left on the Desktop` : 'the copy is missing or differs; original left on the Desktop', 'move')
    const to = await moveOriginal(item.from, item.name)
    res.moved++
    await record('moved', to)
    await log('moved', { from: item.from, to, hash })
  }
}
