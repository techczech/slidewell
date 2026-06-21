/**
 * Screenshot & video triage (ADR-0029). A Triage source is a folder SlideWell READS but never
 * owns (e.g. a OneDrive screenshots folder). Scanning hashes + OCRs every image/video into a
 * SEPARATE index (triage.db, not well.db) so it is searchable during triage — but nothing reaches
 * the curated library until it is INCLUDED, which promotes the file into the well via the normal
 * owned/enriched path. EXCLUDE remembers only the content hash; the original is left untouched.
 *
 * Decisions are keyed by hash (triage_decisions), so a later pass knows what was already decided
 * even if OneDrive moves/renames the file — lightweight and approximate, per ADR-0026. The scan
 * record (triage_fts) is keyed by source-relative path and skipped on re-scan when size+mtime match.
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'
import { query, run, safeFtsQuery } from './sqlite'
import { ocrImage, ingestScreenshot, ingestVideo, makePoster } from './well'

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif', 'tiff', 'tif', 'bmp'])
const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv'])
const SKIP_DIRS = new Set(['.git', 'node_modules', '.Trash', '$RECYCLE.BIN'])

/** Soft gate (ADR-0029): a video over this needs an explicit confirm before include. */
export const VIDEO_GATE_BYTES = 20 * 1024 * 1024

function triageDb(wellRoot: string): string {
  return join(wellRoot, 'triage.db')
}
function postersDir(wellRoot: string): string {
  return join(wellRoot, '_triage-posters')
}

async function ensureTriage(wellRoot: string): Promise<void> {
  mkdirSync(postersDir(wellRoot), { recursive: true })
  const db = triageDb(wellRoot)
  await run(
    db,
    `CREATE VIRTUAL TABLE IF NOT EXISTS triage_fts USING fts5(
       hash UNINDEXED, kind UNINDEXED, rel_path UNINDEXED, filename, ext UNINDEXED,
       size UNINDEXED, mtime UNINDEXED, poster_rel UNINDEXED, ocr_text, scanned_at UNINDEXED
     )`
  )
  await run(db, `CREATE TABLE IF NOT EXISTS triage_decisions (hash TEXT PRIMARY KEY, state TEXT NOT NULL, decided_at TEXT, well_id TEXT)`)
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve) => {
    const h = createHash('sha256')
    const s = createReadStream(path)
    s.on('data', (d) => h.update(d))
    s.on('end', () => resolve(h.digest('hex').slice(0, 12)))
    s.on('error', () => resolve(createHash('sha256').update(path).digest('hex').slice(0, 12)))
  })
}

function* walk(dir: string): Generator<{ abs: string }> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
    const abs = join(dir, e.name)
    if (e.isDirectory()) {
      yield* walk(abs)
    } else if (e.isFile()) {
      yield { abs }
    }
  }
}

interface ScanRow {
  rel_path: string
  size: string
  mtime: string
}

/**
 * Recursively scan a Triage source. Incremental: a file whose (size, mtime) match an existing scan
 * record is skipped without re-hashing or re-OCR. New/changed files are hashed and OCR'd (videos via
 * a poster frame). Returns the number of files (re)indexed. Streams progress via onProgress.
 */
export async function scanTriageSource(
  archiveRoot: string,
  wellRoot: string,
  sourceRoot: string,
  onProgress?: (msg: string) => void
): Promise<{ indexed: number; total: number }> {
  if (!existsSync(sourceRoot)) return { indexed: 0, total: 0 }
  await ensureTriage(wellRoot)
  const db = triageDb(wellRoot)
  const prior = await query<ScanRow>(db, 'SELECT rel_path, size, mtime FROM triage_fts', [])
  const seen = new Map(prior.map((r) => [r.rel_path, `${r.size}:${r.mtime}`]))
  let indexed = 0
  let total = 0
  for (const { abs } of walk(sourceRoot)) {
    const ext = extname(abs).slice(1).toLowerCase()
    const kind = VIDEO_EXT.has(ext) ? 'video' : IMAGE_EXT.has(ext) ? 'image' : null
    if (!kind) continue
    total++
    const st = statSync(abs)
    const rel = relative(sourceRoot, abs)
    const sig = `${st.size}:${Math.round(st.mtimeMs)}`
    if (seen.get(rel) === sig) continue // unchanged since last scan
    const hash = await hashFile(abs)
    let posterRel: string | null = null
    let ocr = ''
    if (kind === 'video') {
      const posterAbs = join(postersDir(wellRoot), `${hash}.jpg`)
      if (existsSync(posterAbs) || (await makePoster(abs, posterAbs))) {
        posterRel = relative(wellRoot, posterAbs)
        ocr = await ocrImage(archiveRoot, posterAbs)
      }
    } else {
      ocr = await ocrImage(archiveRoot, abs)
    }
    await run(db, 'DELETE FROM triage_fts WHERE rel_path = ?', [rel])
    await run(
      db,
      `INSERT INTO triage_fts (hash, kind, rel_path, filename, ext, size, mtime, poster_rel, ocr_text, scanned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [hash, kind, rel, abs.split('/').pop() || rel, ext, String(st.size), String(Math.round(st.mtimeMs)), posterRel || '', ocr, new Date().toISOString()]
    )
    indexed++
    if (indexed % 10 === 0) onProgress?.(`scanned ${indexed} new of ${total}…`)
  }
  onProgress?.(`done — ${indexed} new, ${total} media files`)
  return { indexed, total }
}

export interface TriageRow {
  hash: string
  kind: string
  rel_path: string
  filename: string
  ext: string
  size: string
  poster_rel: string
  ocr_text: string
  state: string
  well_id: string | null
}

const LIST_COLS =
  'triage_fts.hash, triage_fts.kind, triage_fts.rel_path, triage_fts.filename, triage_fts.ext, triage_fts.size, triage_fts.poster_rel, triage_fts.ocr_text, COALESCE(d.state, \'undecided\') AS state, d.well_id'

/** Browse/search the triage index. Empty query → newest scanned first; state '' or 'all' → no filter. */
export async function listTriage(wellRoot: string, raw: string, state: string, limit = 150): Promise<TriageRow[]> {
  const db = triageDb(wellRoot)
  if (!existsSync(db)) return []
  const stateClause = state && state !== 'all' ? `COALESCE(d.state, 'undecided') = '${state.replace(/[^a-z]/g, '')}'` : ''
  const join = 'triage_fts LEFT JOIN triage_decisions d ON d.hash = triage_fts.hash'
  if (raw && raw.trim().length >= 2) {
    const q = safeFtsQuery(raw)
    const where = `triage_fts MATCH ?${stateClause ? ` AND ${stateClause}` : ''}`
    return query<TriageRow>(db, `SELECT ${LIST_COLS} FROM ${join} WHERE ${where} ORDER BY rank LIMIT ?`, [q, limit])
  }
  const where = stateClause ? `WHERE ${stateClause}` : ''
  return query<TriageRow>(db, `SELECT ${LIST_COLS} FROM ${join} ${where} ORDER BY triage_fts.scanned_at DESC LIMIT ?`, [limit])
}

export async function triageCounts(wellRoot: string): Promise<{ undecided: number; included: number; excluded: number; total: number }> {
  const db = triageDb(wellRoot)
  const out = { undecided: 0, included: 0, excluded: 0, total: 0 }
  if (!existsSync(db)) return out
  const rows = await query<{ state: string; n: number }>(
    db,
    `SELECT COALESCE(d.state, 'undecided') AS state, COUNT(*) AS n
     FROM triage_fts LEFT JOIN triage_decisions d ON d.hash = triage_fts.hash GROUP BY state`,
    []
  )
  for (const r of rows) {
    const n = Number(r.n)
    out.total += n
    if (r.state === 'included') out.included = n
    else if (r.state === 'excluded') out.excluded = n
    else out.undecided += n
  }
  return out
}

async function rowByHash(wellRoot: string, hash: string): Promise<{ kind: string; rel_path: string } | null> {
  const r = await query<{ kind: string; rel_path: string }>(triageDb(wellRoot), 'SELECT kind, rel_path FROM triage_fts WHERE hash = ? LIMIT 1', [hash])
  return r[0] ?? null
}

/**
 * Apply a triage decision. include → promote the file into the well (copy + enrich) and remember the
 * resulting well id; exclude → remember the hash only; reset → forget the decision. For a video over
 * the 20 MB gate, include without force returns { gated: true } and copies nothing.
 */
export async function setTriageDecision(
  archiveRoot: string,
  wellRoot: string,
  sourceRoot: string,
  hash: string,
  action: 'include' | 'exclude' | 'reset',
  force = false
): Promise<{ state: string; wellId?: string; gated?: boolean; sizeMB?: number }> {
  await ensureTriage(wellRoot)
  const db = triageDb(wellRoot)
  if (action === 'reset') {
    await run(db, 'DELETE FROM triage_decisions WHERE hash = ?', [hash])
    return { state: 'undecided' }
  }
  if (action === 'exclude') {
    await run(db, 'INSERT OR REPLACE INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, ?, ?, NULL)', [hash, 'excluded', new Date().toISOString()])
    return { state: 'excluded' }
  }
  // include
  const row = await rowByHash(wellRoot, hash)
  if (!row) return { state: 'undecided' }
  const abs = join(sourceRoot, row.rel_path)
  if (!existsSync(abs)) return { state: 'undecided' }
  let wellId: string | undefined
  if (row.kind === 'video') {
    const size = statSync(abs).size
    if (size > VIDEO_GATE_BYTES && !force) return { state: 'undecided', gated: true, sizeMB: Math.round(size / (1024 * 1024)) }
    const res = await ingestVideo(archiveRoot, wellRoot, abs)
    wellId = res?.id
  } else {
    const res = await ingestScreenshot(archiveRoot, wellRoot, abs, 'screenshot')
    wellId = res?.id
  }
  await run(db, 'INSERT OR REPLACE INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, ?, ?, ?)', [hash, 'included', new Date().toISOString(), wellId || ''])
  return { state: 'included', wellId }
}
