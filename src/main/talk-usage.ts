/**
 * Which TalkWeaver talks use which pooled image. SlideWell owns this data (ADR-0026): a read-only scan
 * of the vault's talk Markdown (`*-outline.md`) fills the `talk_image_use` table in well.db, which
 * TalkWeaver can read later. The vault is only ever opened for reading.
 *
 * talk_image_use: one row per (image, talk, slide) the talk references.
 *   image_id       7-hex pool id, the same id as well_fts.id (no `img-` prefix)
 *   talk_rel_path  the talk's outline file, relative to the vault root
 *   talk_title     the talk's title (frontmatter, else first heading, else the file name)
 *   slide          1-based slide number as TalkWeaver's strip numbers slides (approximate)
 *   scanned_at     ISO time of the scan that wrote the row
 * Each scan replaces the whole table, so a removed reference or a deleted talk disappears.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, basename, sep } from 'node:path'
import { query, run } from './sqlite'
import { extractTalkRefs } from './talk-refs'

export interface TalkUse {
  title: string
  /** Vault-relative path of the talk's outline file. */
  relPath: string
  /** Slide of the first reference in this talk, or null when unknown. */
  slide: number | null
}
export type UsageMap = Map<string, TalkUse[]>
export interface ScanSummary { talks: number; references: number; images: number }

function dbPath(root: string): string {
  return join(root, 'well.db')
}

export async function ensureUsageTable(root: string): Promise<void> {
  await run(
    dbPath(root),
    `CREATE TABLE IF NOT EXISTS talk_image_use (
       image_id TEXT NOT NULL, talk_rel_path TEXT NOT NULL, talk_title TEXT NOT NULL,
       slide INTEGER, scanned_at TEXT NOT NULL,
       PRIMARY KEY (image_id, talk_rel_path, slide)
     );
     CREATE INDEX IF NOT EXISTS talk_image_use_talk ON talk_image_use (talk_rel_path)`
  )
}

const SKIP_DIRS = new Set(['_assets', 'cache', 'node_modules', '_SLIDE-VERSIONS'])

/** Vault-relative paths of every talk outline (`*-outline.md`), skipping the pool, caches and dot folders. */
export function findTalkFiles(vaultRoot: string): string[] {
  const out: string[] = []
  const walk = (rel: string, depth: number): void => {
    if (depth > 6) return
    let entries
    try { entries = readdirSync(join(vaultRoot, rel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const r = rel ? join(rel, e.name) : e.name
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(r, depth + 1) }
      else if (e.isFile() && /-outline\.md$/i.test(e.name)) out.push(r)
    }
  }
  walk('', 0)
  return out.sort()
}

/** Read every talk and replace the usage table. Read-only on the vault. */
export async function scanTalkUsage(root: string, vaultRoot: string): Promise<ScanSummary> {
  await ensureUsageTable(root)
  const now = new Date().toISOString()
  const rows: Array<[string, string, string, number | null]> = []
  const talks = findTalkFiles(vaultRoot)
  const images = new Set<string>()
  for (const rel of talks) {
    let text: string
    try { text = readFileSync(join(vaultRoot, rel), 'utf8') } catch { continue }
    const { title, refs } = extractTalkRefs(text)
    const t = title || basename(rel).replace(/-outline\.md$/i, '').replace(/-/g, ' ')
    for (const r of refs) { rows.push([r.id, rel, t, r.slide]); images.add(r.id) }
  }
  const db = dbPath(root)
  await run(db, 'DELETE FROM talk_image_use')
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200)
    const values = batch.map(() => '(?, ?, ?, ?, ?)').join(', ')
    const params = batch.flatMap((r) => [r[0], r[1], r[2], r[3], now])
    await run(db, `INSERT OR IGNORE INTO talk_image_use (image_id, talk_rel_path, talk_title, slide, scanned_at) VALUES ${values}`, params, 20000)
  }
  return { talks: talks.length, references: rows.length, images: images.size }
}

/** Group table rows by image; one entry per talk (its earliest slide), talks in title order. */
export function groupUsage(rows: Array<{ image_id: string; talk_rel_path: string; talk_title: string; slide: number | string | null }>): UsageMap {
  const out: UsageMap = new Map()
  for (const r of rows) {
    const slide = r.slide === null || r.slide === undefined ? null : Number(r.slide)
    const list = out.get(r.image_id) ?? []
    const prev = list.find((u) => u.relPath === r.talk_rel_path)
    if (prev) { if (slide !== null && (prev.slide === null || slide < prev.slide)) prev.slide = slide }
    else list.push({ title: r.talk_title, relPath: r.talk_rel_path, slide })
    out.set(r.image_id, list)
  }
  for (const list of out.values()) list.sort((a, b) => a.title.localeCompare(b.title))
  return out
}

export async function loadUsage(root: string): Promise<UsageMap> {
  if (!existsSync(dbPath(root))) return new Map()
  try {
    return groupUsage(await query(dbPath(root), 'SELECT image_id, talk_rel_path, talk_title, slide FROM talk_image_use'))
  } catch {
    return new Map() // table not created yet
  }
}

/** Absolute talk path for a vault-relative one, or null when it would leave the vault. */
export function talkAbsPath(vaultRoot: string, relPath: string): string | null {
  const abs = join(vaultRoot, relPath)
  if (!abs.startsWith(vaultRoot.endsWith(sep) ? vaultRoot : vaultRoot + sep)) return null
  try { return statSync(abs).isFile() ? abs : null } catch { return null }
}
