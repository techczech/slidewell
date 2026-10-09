/**
 * Execution layer for the one-off screenshot backlog import (ticket 13). Small interface:
 *   listBacklog(env)  → read-only listings (names, sizes, mtimes); never opens a file
 *   dryRun(env)       → the plan (backlog-plan.ts); writes nothing anywhere
 *   runImport(plan, env, opts) → copy → verify → move, with a ledger and a log
 *
 * Safety rules this module holds:
 * - Nothing is deleted. Originals in CleanShot's history are only read. A Desktop original is moved
 *   (rename, same volume) into `Moved by SlideWell <date>` only after a hash-verified copy exists in
 *   the watched folder. Across volumes the move is skipped and logged, never emulated by copy+unlink.
 *   The single exception: this module's own `.slidewell-partial` temp file is removed when its copy
 *   fails inside the same call (it never held anyone's data but this call's half-written bytes).
 * - Nothing is overwritten. A taken name holding the same content (by hash) is reused; different
 *   content gets `name (2).ext`, `name (3).ext`, ….
 * - Copies are atomic: write a dot-named temp in the destination folder, fsync, rename, then re-hash
 *   the final file. EDEADLK / EAGAIN / EBUSY (OneDrive) are retried with backoff. No watcher events
 *   drive this; the run walks its plan.
 * - Resume: the ledger (JSONL, fsynced per line, in SlideWell's own data folder) is keyed by content
 *   hash per watched folder, so a re-run after an interruption copies nothing twice.
 */
import { createHash, randomBytes } from 'node:crypto'
import { constants as FS, createReadStream, existsSync, promises as fsp } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { alternativeName, PARTIAL_SUFFIX, planBacklogImport, parseLedger, type BacklogPlan, type LedgerEntry, type ListedFile, type PlanItem } from './backlog-plan'

export type BacklogEnv = {
  desktopDir: string
  cleanshotDir: string | null // CleanShot's history media folder; null when absent
  watchedFolder: string | null
  stateDir: string // ledger + logs (SlideWell's own data folder, not the watched folder)
  now?: () => Date
  /** Filesystem calls the run uses for moves and renames; tests inject faults here. */
  ops?: Partial<FsOps>
  retry?: { tries?: number; baseMs?: number }
}

export type FsOps = {
  rename: (from: string, to: string) => Promise<void>
}

export type RunProgress = { done: number; total: number; name: string }
export type RunResult = {
  ok: boolean
  cancelled: boolean
  copied: number // new verified copies written
  reused: number // identical file already in the watched folder (same name, same hash)
  alreadyDone: number // ledger already had this content
  moved: number // Desktop originals moved
  moveSkipped: number // Desktop originals left in place (cross-volume or failed move), logged
  gone: number // file vanished or changed since the plan
  failed: number
  logPath: string
  errors: string[]
}

const RETRY_CODES = new Set(['EDEADLK', 'EAGAIN', 'EBUSY'])

export function ledgerPath(stateDir: string): string {
  return join(stateDir, 'backlog-ledger.jsonl')
}

export function localDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

async function withRetry<T>(fn: () => Promise<T>, env: BacklogEnv): Promise<T> {
  const tries = env.retry?.tries ?? 6
  const base = env.retry?.baseMs ?? 100
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (!code || !RETRY_CODES.has(code) || i >= tries - 1) throw e
      await new Promise((r) => setTimeout(r, base * 2 ** i))
    }
  }
}

async function hashFile(path: string, env: BacklogEnv): Promise<string> {
  return withRetry(
    () =>
      new Promise<string>((resolve, reject) => {
        const h = createHash('sha256')
        createReadStream(path)
          .on('data', (c) => h.update(c))
          .on('error', reject)
          .on('end', () => resolve(h.digest('hex')))
      }),
    env
  )
}

// ---------- listing (read-only) ----------

async function listFiles(root: string, depth: 1 | 2): Promise<ListedFile[]> {
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
          if (st.isFile()) out.push({ rel: r, size: st.size, mtimeMs: Math.round(st.mtimeMs) })
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

export async function listBacklog(env: BacklogEnv): Promise<{ desktop: ListedFile[]; cleanshot: ListedFile[]; watchedNames: string[] }> {
  const desktop = existsSync(env.desktopDir) ? await listFiles(env.desktopDir, 1) : []
  const cleanshot = env.cleanshotDir && existsSync(env.cleanshotDir) ? await listFiles(env.cleanshotDir, 2) : []
  let watchedNames: string[] = []
  if (env.watchedFolder) watchedNames = await fsp.readdir(env.watchedFolder).catch(() => [])
  // folders below the listing depth appear as `<rel>/…` markers: ignored on the Desktop, counted as skipped in CleanShot
  return { desktop: desktop.filter((f) => !f.rel.endsWith('/…')), cleanshot, watchedNames }
}

/** The dry run: listings + ledger → plan. Writes nothing (no state folder, no log). */
export async function dryRun(env: BacklogEnv): Promise<BacklogPlan> {
  const l = await listBacklog(env)
  return planBacklogImport({
    watchedFolder: env.watchedFolder,
    desktopDir: env.desktopDir,
    cleanshotDir: env.cleanshotDir && existsSync(env.cleanshotDir) ? env.cleanshotDir : null,
    desktop: l.desktop,
    cleanshot: l.cleanshot,
    watchedNames: l.watchedNames,
    ledger: await readLedger(env.stateDir),
    date: localDate((env.now ?? (() => new Date()))())
  })
}

// ---------- writing ----------

async function appendLine(path: string, obj: unknown, env: BacklogEnv): Promise<void> {
  await withRetry(async () => {
    const fh = await fsp.open(path, 'a')
    try {
      await fh.write(`${JSON.stringify(obj)}\n`)
      await fh.sync()
    } finally {
      await fh.close()
    }
  }, env)
}

/** Atomic copy into `target`: temp in the same folder → fsync → rename → re-hash. Returns the verified hash. */
async function atomicCopy(from: string, target: string, expected: string, env: BacklogEnv, ops: FsOps): Promise<void> {
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}-${randomBytes(4).toString('hex')}${PARTIAL_SUFFIX}`)
  let renamed = false
  try {
    await withRetry(async () => {
      const fh = await fsp.open(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC)
      const h = createHash('sha256')
      try {
        await new Promise<void>((resolve, reject) => {
          const rs = createReadStream(from)
          rs.on('data', (chunk) => {
            rs.pause()
            h.update(chunk)
            fh.write(chunk as Buffer).then(() => rs.resume(), reject)
          })
          rs.on('error', reject)
          rs.on('end', resolve)
        })
        await fh.sync()
      } finally {
        await fh.close()
      }
      if (h.digest('hex') !== expected) throw Object.assign(new Error('source changed while copying'), { code: 'ECHANGED' })
    }, env)
    if (existsSync(target)) throw Object.assign(new Error('name taken during copy'), { code: 'EEXIST' })
    await withRetry(() => ops.rename(tmp, target), env)
    renamed = true
  } finally {
    if (!renamed) await fsp.unlink(tmp).catch(() => undefined) // our own half-written temp only
  }
  const got = await hashFile(target, env)
  if (got !== expected) throw new Error(`copy did not verify (${basename(target)})`) // left in place; never deleted
}

/** Put a verified copy of `from` (content `hash`) into `dir`, never overwriting. */
async function placeCopy(from: string, hash: string, dir: string, name: string, env: BacklogEnv, ops: FsOps): Promise<{ dest: string; reused: boolean }> {
  for (let n = 1; n < 1000; n++) {
    const target = join(dir, n === 1 ? name : alternativeName(name, n))
    if (existsSync(target)) {
      if ((await hashFile(target, env)) === hash) return { dest: target, reused: true }
      continue
    }
    try {
      await atomicCopy(from, target, hash, env, ops)
      return { dest: target, reused: false }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw e
    }
  }
  throw new Error(`no free name for ${name}`)
}

/** Move a Desktop original into the moved folder under a free name. Returns the new path, or null if left in place. */
async function moveOriginal(from: string, movedFolder: string, name: string, env: BacklogEnv, ops: FsOps): Promise<{ to: string | null; why?: string }> {
  await withRetry(() => fsp.mkdir(movedFolder, { recursive: true }).then(() => undefined), env)
  for (let n = 1; n < 1000; n++) {
    const to = join(movedFolder, n === 1 ? name : alternativeName(name, n))
    if (existsSync(to)) continue
    try {
      await withRetry(() => ops.rename(from, to), env)
      return { to }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EXDEV') return { to: null, why: 'different volume; left on the Desktop' }
      throw e
    }
  }
  return { to: null, why: 'no free name in the moved folder' }
}

export async function runImport(
  plan: BacklogPlan,
  env: BacklogEnv,
  opts: { onProgress?: (p: RunProgress) => void; signal?: AbortSignal } = {}
): Promise<RunResult> {
  const now = env.now ?? (() => new Date())
  await fsp.mkdir(join(env.stateDir, 'logs'), { recursive: true })
  const logPath = join(env.stateDir, 'logs', `backlog-import-${now().toISOString().replace(/[:.]/g, '-')}.jsonl`)
  const res: RunResult = { ok: false, cancelled: false, copied: 0, reused: 0, alreadyDone: 0, moved: 0, moveSkipped: 0, gone: 0, failed: 0, logPath, errors: [] }
  const log = (event: string, extra: Record<string, unknown> = {}): Promise<void> => appendLine(logPath, { at: now().toISOString(), event, ...extra }, env)
  if (!plan.ok) {
    await log('refused', { reason: plan.reason })
    return res
  }
  const ops: FsOps = { rename: (a, b) => fsp.rename(a, b), ...env.ops }
  const watched = plan.watchedFolder
  const movedFolder = plan.movedFolder
  const ledgerFile = ledgerPath(env.stateDir)
  const byHash = new Map<string, LedgerEntry>()
  for (const e of await readLedger(env.stateDir)) if (e.watched === watched && e.step === 'copied') byHash.set(e.hash, e)

  await log('start', { watched, items: plan.items.length, desktop: plan.summary.desktop.count, cleanshot: plan.summary.cleanshot.count })
  const total = plan.items.length
  let done = 0
  for (const item of plan.items) {
    opts.onProgress?.({ done, total, name: item.name })
    if (opts.signal?.aborted) {
      res.cancelled = true
      break
    }
    try {
      await importOne(item)
    } catch (e) {
      res.failed++
      const msg = `${item.name}: ${(e as Error).message}`
      res.errors.push(msg)
      await log('failed', { source: item.source, from: item.from, error: (e as Error).message }).catch(() => undefined)
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
    const hash = await hashFile(item.from, env)
    const record = async (step: 'copied' | 'moved', dest: string): Promise<void> => {
      const e: LedgerEntry = { step, hash, watched, source: item.source, from: item.from, size: st.size, mtimeMs: Math.round(st.mtimeMs), dest, at: now().toISOString() }
      await appendLine(ledgerFile, e, env)
      if (step === 'copied') byHash.set(hash, e)
    }

    // 1. a verified copy in the watched folder
    let copy: string | null = null
    const prior = byHash.get(hash)
    if (prior) {
      if (item.source === 'cleanshot') {
        res.alreadyDone++
        await log('already-done', { source: item.source, from: item.from, hash, dest: prior.dest })
        return
      }
      // a Desktop original moves only if its copy still exists and verifies
      if (existsSync(prior.dest) && (await hashFile(prior.dest, env)) === hash) {
        copy = prior.dest
        res.alreadyDone++
        await log('already-done', { source: item.source, from: item.from, hash, dest: prior.dest })
      }
    }
    if (!copy) {
      const placed = await placeCopy(item.from, hash, watched, item.name, env, ops)
      copy = placed.dest
      if (placed.reused) res.reused++
      else res.copied++
      await record('copied', copy)
      await log(placed.reused ? 'reused' : 'copied', { source: item.source, from: item.from, to: copy, hash, verified: true })
    }

    // 2. Desktop only: move the original (never delete)
    if (item.source !== 'desktop') return
    const mv = await moveOriginal(item.from, movedFolder, item.name, env, ops)
    if (!mv.to) {
      res.moveSkipped++
      await log('move-skipped', { from: item.from, reason: mv.why })
      return
    }
    res.moved++
    await record('moved', mv.to)
    await log('moved', { from: item.from, to: mv.to, hash })
  }
}
