/**
 * Which TalkWeaver talks use which pooled image. SlideWell owns this data (ADR-0026): a read-only scan
 * of the vault's talk Markdown (`*-outline.md`) fills tables in well.db, which TalkWeaver can read
 * later. The vault is only ever opened for reading, and nothing is written when the database would
 * land inside the vault.
 *
 * talk_image_use: one row per (image, talk, slide) the talk references.
 *   image_id       7-hex pool id, the same id as well_fts.id (no `img-` prefix)
 *   talk_rel_path  the talk's outline file, relative to the vault root
 *   talk_title     the talk's title (frontmatter, else `#` heading, else the file name)
 *   slide          1-based slide number as TalkWeaver's strip numbers slides (approximate)
 *   scanned_at     ISO time of the scan that wrote the row
 * talk_usage_meta: key/value rows saying what the snapshot describes: vault_root (real path of the
 *   vault scanned), scanned_at, talks, refs.
 * A scan replaces both in ONE transaction, and only after the whole vault was read: a failed or
 * superseded scan leaves the previous snapshot untouched.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, basename, dirname, sep } from 'node:path'
import { query, run } from './sqlite'
import { extractTalkRefs } from './talk-refs'
import type { TalkUse } from '../preload/index'

export type { TalkUse }
export type UsageMap = Map<string, TalkUse[]>
export interface ScanSummary { talks: number; references: number; images: number }
export type ScanOutcome =
  | { status: 'ok'; summary: ScanSummary }
  | { status: 'kept'; reason: 'vault-unavailable' | 'read-failed' | 'db-inside-vault' | 'superseded' | 'write-failed'; detail?: string }

function dbPath(root: string): string {
  return join(root, 'well.db')
}

const real = (p: string): string | null => {
  try { return realpathSync(p) } catch { return null }
}
const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)

/** True when a writable well.db in `wellRoot` would sit inside the vault (directly or through a symlink). */
export function wellInsideVault(wellRoot: string, vaultRoot: string): boolean {
  const v = real(vaultRoot)
  if (!v) return false
  // the well folder may not exist yet: resolve its nearest existing ancestor
  let dir = wellRoot
  let w = real(dir)
  while (!w && dirname(dir) !== dir) { dir = dirname(dir); w = real(dir) }
  if (w && inside(w, v)) return true
  const db = real(dbPath(wellRoot)) // a symlinked well.db file itself
  return Boolean(db && inside(db, v))
}

export async function ensureUsageTable(root: string): Promise<void> {
  await run(
    dbPath(root),
    `CREATE TABLE IF NOT EXISTS talk_image_use (
       image_id TEXT NOT NULL, talk_rel_path TEXT NOT NULL, talk_title TEXT NOT NULL,
       slide INTEGER NOT NULL DEFAULT 0, scanned_at TEXT NOT NULL,
       PRIMARY KEY (image_id, talk_rel_path, slide)
     );
     CREATE INDEX IF NOT EXISTS talk_image_use_talk ON talk_image_use (talk_rel_path);
     CREATE TABLE IF NOT EXISTS talk_usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
  )
}

const SKIP_DIRS = new Set(['_assets', 'cache', 'node_modules', '_SLIDE-VERSIONS'])
const isOutlineName = (n: string): boolean => /-outline\.md$/i.test(n)

/** Is this vault-relative path one a scan would treat as a talk outline? */
export function isTalkOutlinePath(rel: string): boolean {
  if (!rel || !isOutlineName(rel)) return false
  const parts = rel.split(/[\\/]/)
  return parts.every((p) => p !== '' && p !== '..' && !p.startsWith('.') && !(SKIP_DIRS.has(p) && p !== parts[parts.length - 1]))
}

/** Should a change at this vault-relative path trigger a rescan? A talk outline, or a folder (which may hold or lose talks). */
export function isVaultChangeRelevant(rel: string): boolean {
  if (isTalkOutlinePath(rel)) return true
  const parts = rel.split(/[\\/]/)
  if (parts.some((p) => p.startsWith('.') || SKIP_DIRS.has(p))) return false
  return !/\.[A-Za-z0-9]{1,6}$/.test(parts[parts.length - 1]) // no extension: probably a folder
}

/** Vault-relative talk outlines, or `ok: false` when any directory could not be read. */
export function findTalkFiles(vaultRoot: string): { files: string[]; ok: boolean } {
  const out: string[] = []
  let ok = true
  const walk = (rel: string, depth: number): void => {
    if (depth > 6) return
    let entries
    try { entries = readdirSync(join(vaultRoot, rel), { withFileTypes: true }) } catch { ok = false; return }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const r = rel ? join(rel, e.name) : e.name
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(r, depth + 1) }
      else if (e.isFile() && isOutlineName(e.name)) out.push(r)
    }
  }
  walk('', 0)
  return { files: out.sort(), ok }
}

/**
 * Read every talk and replace the usage snapshot in one transaction. Read-only on the vault.
 * `isCurrent` lets the caller drop a result whose vault is no longer the current one.
 */
export async function scanTalkUsage(root: string, vaultRoot: string, isCurrent: () => boolean = () => true): Promise<ScanOutcome> {
  const vault = real(vaultRoot)
  if (!vault || !statSync(vault).isDirectory()) return { status: 'kept', reason: 'vault-unavailable' }
  if (wellInsideVault(root, vault)) return { status: 'kept', reason: 'db-inside-vault', detail: 'the well folder is inside the vault; nothing is written there' }
  const found = findTalkFiles(vault)
  if (!found.ok) return { status: 'kept', reason: 'read-failed', detail: 'a folder in the vault could not be read' }
  // the pool catalogue: the ids of the images actually in the vault's _assets folder
  const pool = new Set<string>()
  try {
    for (const f of readdirSync(join(vault, '_assets'))) {
      const m = /^img-(?:img-)?([0-9a-f]{7,})\.[A-Za-z0-9]{2,5}$/i.exec(f)
      if (m) pool.add(m[1].toLowerCase().slice(0, 7))
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { status: 'kept', reason: 'read-failed', detail: 'the image pool could not be read' }
  }
  const rows: Array<[string, string, string, number]> = []
  const images = new Set<string>()
  for (const rel of found.files) {
    let text: string
    try { text = readFileSync(join(vault, rel), 'utf8') } catch { return { status: 'kept', reason: 'read-failed', detail: 'a talk could not be read' } }
    // a talk's own pool-named copy counts as the pool image, but only when that image is in the pool
    const { title, refs } = extractTalkRefs(text, { includeTalkAssets: true })
    const t = title || basename(rel).replace(/-outline\.md$/i, '').replace(/-/g, ' ')
    for (const r of refs) {
      if (r.via === 'local' && !pool.has(r.id)) continue
      rows.push([r.id, rel, t, r.slide]); images.add(r.id)
    }
  }
  if (!isCurrent()) return { status: 'kept', reason: 'superseded' }
  const now = new Date().toISOString()
  const q = (s: string): string => `'${s.replace(/'/g, "''")}'`
  const stmts: string[] = ['.bail on', 'BEGIN IMMEDIATE;', 'DELETE FROM talk_image_use;', 'DELETE FROM talk_usage_meta;']
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200).map((r) => `(${q(r[0])}, ${q(r[1])}, ${q(r[2])}, ${r[3]}, ${q(now)})`)
    stmts.push(`INSERT OR IGNORE INTO talk_image_use (image_id, talk_rel_path, talk_title, slide, scanned_at) VALUES ${batch.join(', ')};`)
  }
  const meta: Array<[string, string]> = [['vault_root', vault], ['scanned_at', now], ['talks', String(found.files.length)], ['refs', String(rows.length)]]
  stmts.push(`INSERT INTO talk_usage_meta (key, value) VALUES ${meta.map(([k, v]) => `(${q(k)}, ${q(v)})`).join(', ')};`, 'COMMIT;')
  try {
    await ensureUsageTable(root)
    // one sqlite3 process, one connection, one transaction: readers see the old or the new snapshot, never a mix
    await run(dbPath(root), stmts.join('\n'), [], 60000)
  } catch (e) {
    return { status: 'kept', reason: 'write-failed', detail: e instanceof Error ? e.message : String(e) }
  }
  return { status: 'ok', summary: { talks: found.files.length, references: rows.length, images: images.size } }
}

/** Group table rows by image; one entry per talk (its earliest slide), talks in title order. */
export function groupUsage(rows: Array<{ image_id: string; talk_rel_path: string; talk_title: string; slide: number | string | null }>): UsageMap {
  const out: UsageMap = new Map()
  for (const r of rows) {
    const n = r.slide === null || r.slide === undefined ? 0 : Number(r.slide)
    const slide = n > 0 ? n : null
    const list = out.get(r.image_id) ?? []
    const prev = list.find((u) => u.relPath === r.talk_rel_path)
    if (prev) { if (slide !== null && (prev.slide === null || slide < prev.slide)) prev.slide = slide }
    else list.push({ title: r.talk_title, relPath: r.talk_rel_path, slide })
    out.set(r.image_id, list)
  }
  for (const list of out.values()) list.sort((a, b) => a.title.localeCompare(b.title))
  return out
}

/** The stored snapshot, but only when it describes `vaultRoot` (otherwise empty). */
export async function loadUsage(root: string, vaultRoot: string | null): Promise<UsageMap> {
  if (!existsSync(dbPath(root)) || !vaultRoot) return new Map()
  const v = real(vaultRoot)
  if (!v) return new Map()
  try {
    const meta = await query<{ value: string }>(dbPath(root), "SELECT value FROM talk_usage_meta WHERE key = 'vault_root'")
    if (meta[0]?.value !== v) return new Map()
    return groupUsage(await query(dbPath(root), 'SELECT image_id, talk_rel_path, talk_title, slide FROM talk_image_use'))
  } catch {
    return new Map() // tables not created yet
  }
}

/** Absolute path of a talk outline, or null: not an outline, or (after resolving symlinks) outside the vault. */
export function talkAbsPath(vaultRoot: string, relPath: string): string | null {
  if (!isTalkOutlinePath(relPath)) return null
  const v = real(vaultRoot)
  const abs = v ? real(join(v, relPath)) : null
  if (!v || !abs || !inside(abs, v) || abs === v) return null
  try { return statSync(abs).isFile() ? abs : null } catch { return null }
}

/**
 * Runs scans one at a time. A request made while a scan runs waits; a newer request replaces one
 * already waiting, so a burst of changes costs at most one extra scan.
 */
export function createScanQueue<A>(work: (arg: A) => Promise<void>): { request: (arg: A) => Promise<void>; idle: () => Promise<void> } {
  let running: Promise<void> | null = null
  let pending: { arg: A; waiters: Array<() => void> } | null = null
  const drain = async (arg: A): Promise<void> => {
    try { await work(arg) } catch { /* the work reports its own failures */ }
    if (pending) {
      const next = pending
      pending = null
      await drain(next.arg)
      next.waiters.forEach((w) => w())
    }
  }
  const request = (arg: A): Promise<void> => {
    if (!running) {
      running = drain(arg).finally(() => { running = null })
      return running
    }
    if (pending) {
      return new Promise((resolve) => { pending!.arg = arg; pending!.waiters.push(resolve) })
    }
    return new Promise((resolve) => { pending = { arg, waiters: [resolve] } })
  }
  return { request, idle: () => running ?? Promise.resolve() }
}
