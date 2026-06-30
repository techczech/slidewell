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
import { tallyTriageStates, planSelectedImport, type TriageCounts } from './triage-logic'

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
  // NB: NOT WAL — our reads open the db read-only (mode=ro), which can't see un-checkpointed WAL
  // frames. The default rollback journal + a busy_timeout (sqlite.ts) lets mid-scan reads simply
  // wait out the sub-millisecond write locks, and the UI retries on the next progress tick.
  // The scan index gained an `offline` column (OneDrive placeholders). It is fully rebuildable, so
  // if an older schema is present just drop + recreate it; decisions (keyed by hash) are preserved.
  try {
    await query(db, 'SELECT offline FROM triage_fts LIMIT 0', [])
  } catch {
    await run(db, 'DROP TABLE IF EXISTS triage_fts').catch(() => undefined)
  }
  await run(
    db,
    `CREATE VIRTUAL TABLE IF NOT EXISTS triage_fts USING fts5(
       hash UNINDEXED, kind UNINDEXED, rel_path UNINDEXED, filename, ext UNINDEXED,
       size UNINDEXED, mtime UNINDEXED, poster_rel UNINDEXED, offline UNINDEXED, ocr_text, scanned_at UNINDEXED
     )`
  )
  await run(db, `CREATE TABLE IF NOT EXISTS triage_decisions (hash TEXT PRIMARY KEY, state TEXT NOT NULL, decided_at TEXT, well_id TEXT)`)
}

// Content hash of a file, or null if the read stalls (e.g. a OneDrive placeholder that slipped past
// the blocks===0 check and is silently downloading). The timeout keeps one bad file from freezing
// the whole scan — the caller degrades a null to a "not downloaded" row.
function hashFile(path: string, timeoutMs = 15000): Promise<string | null> {
  return new Promise((resolve) => {
    const h = createHash('sha256')
    const s = createReadStream(path)
    const done = (v: string | null): void => {
      clearTimeout(t)
      s.destroy()
      resolve(v)
    }
    const t = setTimeout(() => done(null), timeoutMs)
    s.on('data', (d) => h.update(d))
    s.on('end', () => done(h.digest('hex').slice(0, 12)))
    s.on('error', () => done(null))
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

interface ScanItem {
  abs: string
  rel: string
  kind: 'image' | 'video'
  ext: string
  size: number
  mtime: number
  offline: boolean
}

/**
 * Recursively scan a Triage source in two phases so the UI gets continuous feedback (ADR-0029):
 *
 *  - Phase 0 (fast): walk + stat every media file. `stat` never hydrates OneDrive placeholders, so
 *    this completes even on a folder that is mostly online-only. Emits a running "found N" count.
 *  - Phase 1 (incremental): for each new/changed file, hash + OCR it and write its row, emitting
 *    `processed i/N` per file so the caller can show progress and re-list as rows land.
 *
 * OneDrive **online-only placeholders** (size > 0 but zero allocated blocks) are indexed from their
 * stat alone and NEVER read — reading would force a slow download (the "stuck on nothing" symptom).
 * They are flagged `offline` so the UI can show them as "not downloaded" and skip their thumbnails.
 */
export async function scanTriageSource(
  archiveRoot: string,
  wellRoot: string,
  sourceRoot: string,
  onProgress?: (msg: string) => void
): Promise<{ indexed: number; total: number; offline: number }> {
  if (!existsSync(sourceRoot)) return { indexed: 0, total: 0, offline: 0 }
  await ensureTriage(wellRoot)
  const db = triageDb(wellRoot)
  const prior = await query<ScanRow>(db, 'SELECT rel_path, size, mtime FROM triage_fts', [])
  const seen = new Map(prior.map((r) => [r.rel_path, `${r.size}:${r.mtime}`]))

  // Phase 0 — enumerate (stat only).
  const files: ScanItem[] = []
  for (const { abs } of walk(sourceRoot)) {
    const ext = extname(abs).slice(1).toLowerCase()
    const kind = VIDEO_EXT.has(ext) ? 'video' : IMAGE_EXT.has(ext) ? 'image' : null
    if (!kind) continue
    try {
      const st = statSync(abs)
      files.push({ abs, rel: relative(sourceRoot, abs), kind, ext, size: st.size, mtime: Math.round(st.mtimeMs), offline: st.size > 0 && st.blocks === 0 })
    } catch {
      continue
    }
    if (files.length % 200 === 0) onProgress?.(`found ${files.length} media files…`)
  }
  onProgress?.(`found ${files.length} media files — reading…`)

  // Phase 1 — process new/changed files one at a time, committing + reporting per file.
  let indexed = 0
  let offlineN = 0
  let i = 0
  for (const f of files) {
    i++
    const sig = `${f.size}:${f.mtime}`
    if (seen.get(f.rel) === sig) {
      if (f.offline) offlineN++
      continue
    }
    const pathId = (): string => 'p:' + createHash('sha256').update(`${f.rel}:${sig}`).digest('hex').slice(0, 11)
    let hash: string
    let ocr = ''
    let posterRel = ''
    let rowOffline = f.offline
    if (f.offline) {
      hash = pathId() // online-only placeholder; never read
      offlineN++
    } else {
      const h = await hashFile(f.abs)
      if (h === null) {
        // unreadable / stalled read — treat like a not-downloaded file rather than hang
        hash = pathId()
        rowOffline = true
        offlineN++
      } else if (f.kind === 'video') {
        hash = h
        const posterAbs = join(postersDir(wellRoot), `${hash}.jpg`)
        if (existsSync(posterAbs) || (await makePoster(f.abs, posterAbs))) {
          posterRel = relative(wellRoot, posterAbs)
          ocr = await ocrImage(archiveRoot, posterAbs)
        }
        indexed++
      } else {
        hash = h
        ocr = await ocrImage(archiveRoot, f.abs)
        indexed++
      }
    }
    await run(
      db,
      `DELETE FROM triage_fts WHERE rel_path = ?;
       INSERT INTO triage_fts (hash, kind, rel_path, filename, ext, size, mtime, poster_rel, offline, ocr_text, scanned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [f.rel, hash, f.kind, f.rel, f.abs.split('/').pop() || f.rel, f.ext, String(f.size), String(f.mtime), posterRel, rowOffline ? '1' : '0', ocr, new Date().toISOString()]
    )
    if (i % 3 === 0 || i === files.length) onProgress?.(`processed ${i}/${files.length} · ${indexed} read · ${offlineN} not downloaded`)
  }
  onProgress?.(`done — ${indexed} read, ${offlineN} not downloaded, ${files.length} total`)
  return { indexed, total: files.length, offline: offlineN }
}

export interface TriageRow {
  hash: string
  kind: string
  rel_path: string
  filename: string
  ext: string
  size: string
  mtime: string
  poster_rel: string
  offline: string
  ocr_text: string
  state: string
  well_id: string | null
}

const LIST_COLS =
  'triage_fts.hash, triage_fts.kind, triage_fts.rel_path, triage_fts.filename, triage_fts.ext, triage_fts.size, triage_fts.mtime, triage_fts.poster_rel, triage_fts.offline, triage_fts.ocr_text, COALESCE(d.state, \'undecided\') AS state, d.well_id'

export type TriageSort = 'scanned' | 'date-desc' | 'date-asc'

/** Browse/search the triage index. sort: scanned (default) | date-desc | date-asc (by file mtime). */
export async function listTriage(wellRoot: string, raw: string, state: string, sort: TriageSort = 'scanned', limit = 150, offset = 0): Promise<TriageRow[]> {
  const db = triageDb(wellRoot)
  if (!existsSync(db)) return []
  const stateClause = state && state !== 'all' ? `COALESCE(d.state, 'undecided') = '${state.replace(/[^a-z]/g, '')}'` : ''
  const join = 'triage_fts LEFT JOIN triage_decisions d ON d.hash = triage_fts.hash'
  const dateOrder = `ORDER BY CAST(triage_fts.mtime AS INTEGER) ${sort === 'date-asc' ? 'ASC' : 'DESC'}`
  const useDate = sort === 'date-asc' || sort === 'date-desc'
  if (raw && raw.trim().length >= 2) {
    const q = safeFtsQuery(raw)
    const where = `triage_fts MATCH ?${stateClause ? ` AND ${stateClause}` : ''}`
    return query<TriageRow>(db, `SELECT ${LIST_COLS} FROM ${join} WHERE ${where} ${useDate ? dateOrder : 'ORDER BY rank'} LIMIT ? OFFSET ?`, [q, limit, offset])
  }
  const where = stateClause ? `WHERE ${stateClause}` : ''
  return query<TriageRow>(db, `SELECT ${LIST_COLS} FROM ${join} ${where} ${useDate ? dateOrder : 'ORDER BY triage_fts.scanned_at DESC'} LIMIT ? OFFSET ?`, [limit, offset])
}

export async function triageCounts(wellRoot: string): Promise<TriageCounts> {
  const db = triageDb(wellRoot)
  const empty: TriageCounts = { undecided: 0, selected: 0, included: 0, excluded: 0, total: 0 }
  if (!existsSync(db)) return empty
  const rows = await query<{ state: string; n: number }>(
    db,
    `SELECT COALESCE(d.state, 'undecided') AS state, COUNT(*) AS n
     FROM triage_fts LEFT JOIN triage_decisions d ON d.hash = triage_fts.hash GROUP BY state`,
    []
  )
  return tallyTriageStates(rows)
}

async function rowByHash(wellRoot: string, hash: string): Promise<{ kind: string; rel_path: string } | null> {
  const r = await query<{ kind: string; rel_path: string }>(triageDb(wellRoot), 'SELECT kind, rel_path FROM triage_fts WHERE hash = ? LIMIT 1', [hash])
  return r[0] ?? null
}

/**
 * Apply a triage decision. select → stage the item (no ingest, no copy — promoted later by
 * importSelectedTriage); exclude → remember the hash only; reset → forget the decision.
 */
export async function setTriageDecision(
  _archiveRoot: string,
  wellRoot: string,
  _sourceRoot: string,
  hash: string,
  action: 'select' | 'exclude' | 'reset',
  _force = false
): Promise<{ state: string }> {
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
  // select = stage only; nothing reaches the well until importSelectedTriage runs
  await run(db, 'INSERT OR REPLACE INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, ?, ?, NULL)', [hash, 'selected', new Date().toISOString()])
  return { state: 'selected' }
}

/**
 * Promote every staged (state='selected') item into the well. Offline/missing files are skipped; a
 * video over the 20 MB gate is skipped unless its hash is in forceHashes. Imported items move to
 * state='included' with their new well id. Idempotent: a second run finds nothing still 'selected'.
 */
export async function importSelectedTriage(
  archiveRoot: string,
  wellRoot: string,
  sourceRoot: string,
  forceHashes: string[] = []
): Promise<{ imported: number; skipped: number; gated: number }> {
  await ensureTriage(wellRoot)
  const db = triageDb(wellRoot)
  // GROUP BY hash: decisions are keyed by content hash, but triage_fts is keyed by path, so a hash
  // with duplicate files JOINs to multiple rows. One row per hash (like the old rowByHash LIMIT 1)
  // avoids ingesting the same selected item once per duplicate.
  const staged = await query<{ hash: string; kind: string; rel_path: string; offline: string }>(
    db,
    `SELECT triage_fts.hash AS hash, triage_fts.kind AS kind, triage_fts.rel_path AS rel_path, triage_fts.offline AS offline
     FROM triage_fts JOIN triage_decisions d ON d.hash = triage_fts.hash
     WHERE d.state = 'selected'
     GROUP BY triage_fts.hash`,
    []
  )
  const enriched = staged.map((s) => {
    const abs = join(sourceRoot, s.rel_path)
    const missing = !existsSync(abs)
    const sizeBytes = missing ? 0 : statSync(abs).size
    // offline = OneDrive online-only placeholder (stored as '1' at scan time). It can't be ingested
    // (no local bytes), so it is skipped — a keyboard-select bypasses the card's offline-disabled button.
    return { hash: s.hash, kind: s.kind, offline: s.offline === '1', missing, sizeBytes, abs }
  })
  const plan = planSelectedImport(enriched, forceHashes, VIDEO_GATE_BYTES)
  let imported = 0
  for (const hash of plan.toImport) {
    const row = enriched.find((e) => e.hash === hash)
    if (!row) continue
    const res = row.kind === 'video' ? await ingestVideo(archiveRoot, wellRoot, row.abs) : await ingestScreenshot(archiveRoot, wellRoot, row.abs, 'screenshot')
    if (res?.id) {
      await run(db, 'INSERT OR REPLACE INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, ?, ?, ?)', [hash, 'included', new Date().toISOString(), res.id])
      imported++
    }
  }
  return { imported, skipped: plan.skipped.length, gated: plan.gated.length }
}
