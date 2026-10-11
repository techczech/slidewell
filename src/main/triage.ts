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
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { join, relative, extname, basename } from 'node:path'
import { query, run, safeFtsQuery } from './sqlite'
import { ocrImage, ingestScreenshot, ingestVideo, makePoster, recordWellSource } from './well'
import { tallyTriageStates, planSelectedImport, type TriageCounts } from './triage-logic'
import { parseScreenshotName, type NameTemplate } from './screenshot-name'
import { downloadOnlineOnly as downloadInChild, downloadWithDeadline, type DownloadOptions } from './online-only'
import { walk } from './scan-walk'
import { DatabaseSync } from 'node:sqlite'
import { pileOf, type ProposalLabel } from './review/piles'
import { hiddenFromLists } from './review/store'

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif', 'tiff', 'tif', 'bmp'])
const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv'])

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
    await query(db, 'SELECT offline, source, taken_at, app, window_title FROM triage_fts LIMIT 0', [])
  } catch {
    await run(db, 'DROP TABLE IF EXISTS triage_fts').catch(() => undefined)
  }
  await run(
    db,
    `CREATE VIRTUAL TABLE IF NOT EXISTS triage_fts USING fts5(
       hash UNINDEXED, kind UNINDEXED, rel_path UNINDEXED, filename, ext UNINDEXED,
       size UNINDEXED, mtime UNINDEXED, poster_rel UNINDEXED, offline UNINDEXED, ocr_text, scanned_at UNINDEXED,
       source UNINDEXED, taken_at UNINDEXED, app, window_title
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

interface ScanRow {
  source: string
  rel_path: string
  size: string
  mtime: string
  offline: string
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

/** How one source is scanned. `namedOnly` = only files whose names parse as screenshots, top level only (the Desktop). */
export interface ScanOptions {
  namedOnly?: boolean
  /** CleanShot's own name template (cleanshot-folder.ts): Desktop names, date, app and window. */
  nameTemplate?: NameTemplate | null
  /**
   * Download online-only files before reading them (ticket 15: the Desktop and CleanShot's folder only,
   * never the primary Triage folder). One at a time, out of process, with a per-file timeout; after the
   * first file that does not arrive, the rest of this scan indexes online-only files as not downloaded.
   */
  downloadOnlineOnly?: boolean
  downloadTimeoutMs?: number // default 60 s
  /** Test seam: the downloader (default: online-only.ts, a killable child process). */
  download?: (path: string, opts: DownloadOptions) => Promise<void>
}

// Scans share one index and its schema migration, so they run one at a time (watcher + manual Scan).
let scanChain: Promise<unknown> = Promise.resolve()

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
 * Exception (ticket 15): a source scanned with `downloadOnlineOnly` (Desktop, CleanShot's folder) has
 * its online-only files downloaded first, one at a time, out of process and with a timeout; earlier
 * "not downloaded" rows of such a source are tried again.
 */
export function scanTriageSource(
  archiveRoot: string,
  wellRoot: string,
  sourceRoot: string,
  onProgress?: (msg: string) => void,
  opts: ScanOptions = {}
): Promise<{ indexed: number; total: number; offline: number }> {
  const next = scanChain.then(() => scanTriageSourceNow(archiveRoot, wellRoot, sourceRoot, onProgress, opts))
  scanChain = next.catch(() => undefined)
  return next
}

async function scanTriageSourceNow(
  archiveRoot: string,
  wellRoot: string,
  sourceRoot: string,
  onProgress: ((msg: string) => void) | undefined,
  opts: ScanOptions
): Promise<{ indexed: number; total: number; offline: number }> {
  if (!existsSync(sourceRoot)) return { indexed: 0, total: 0, offline: 0 }
  await ensureTriage(wellRoot)
  const db = triageDb(wellRoot)
  const prior = await query<ScanRow>(db, 'SELECT source, rel_path, size, mtime, offline FROM triage_fts', [])
  const seen = new Map(prior.map((r) => [`${r.source}\0${r.rel_path}`, `${r.size}:${r.mtime}`]))
  const wasOffline = new Set(prior.filter((r) => r.offline === '1').map((r) => `${r.source}\0${r.rel_path}`))
  let downloads = Boolean(opts.downloadOnlineOnly) // switched off for the rest of this scan after one failure
  const download = opts.download ?? downloadInChild

  // Phase 0 — enumerate (stat only).
  const files: ScanItem[] = []
  for (const { abs } of walk(sourceRoot, !opts.namedOnly)) {
    const ext = extname(abs).slice(1).toLowerCase()
    const kind = VIDEO_EXT.has(ext) ? 'video' : IMAGE_EXT.has(ext) ? 'image' : null
    if (!kind) continue
    if (opts.namedOnly && !parseScreenshotName(basename(abs), opts.nameTemplate)) continue
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
    const key = `${sourceRoot}\0${f.rel}`
    if (seen.get(key) === sig && !(downloads && wasOffline.has(key))) {
      if (f.offline) offlineN++
      continue
    }
    if (f.offline && downloads) {
      try {
        onProgress?.(`downloading ${basename(f.abs)}…`)
        await downloadWithDeadline(f.abs, download, { timeoutMs: opts.downloadTimeoutMs ?? 60_000 })
        const st = statSync(f.abs)
        if (st.isFile() && st.blocks > 0) f.offline = false
        else downloads = false
      } catch {
        downloads = false // offline or stuck: do not wait on every other file in this scan
      }
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
    const name = f.abs.split('/').pop() || f.rel
    const parsed = parseScreenshotName(name, opts.nameTemplate)
    await run(
      db,
      `DELETE FROM triage_fts WHERE rel_path = ? AND source = ?;
       INSERT INTO triage_fts (hash, kind, rel_path, filename, ext, size, mtime, poster_rel, offline, ocr_text, scanned_at, source, taken_at, app, window_title)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [f.rel, sourceRoot, hash, f.kind, f.rel, name, f.ext, String(f.size), String(f.mtime), posterRel, rowOffline ? '1' : '0', ocr, new Date().toISOString(), sourceRoot, parsed?.takenAt ?? '', parsed?.app ?? '', parsed?.window ?? '']
    )
    if (i % 3 === 0 || i === files.length) onProgress?.(`processed ${i}/${files.length} · ${indexed} read · ${offlineN} not downloaded`)
  }
  onProgress?.(`done — ${indexed} read, ${offlineN} not downloaded, ${files.length} total`)
  return { indexed, total: files.length, offline: offlineN }
}

export interface TriageRow {
  source: string // absolute root of the source folder this file was found in
  taken_at: string // parsed from the file name ('' when the name carries no date)
  app: string
  window_title: string
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
  decided_at?: string | null
  // the sorter's proposal for this item, when it made one (review piles, ticket 08)
  proposal?: string | null
  proposed_at?: string | null
  throwaway_since?: string | null
}

const LIST_COLS =
  'triage_fts.source, triage_fts.taken_at, triage_fts.app, triage_fts.window_title, triage_fts.hash, triage_fts.kind, triage_fts.rel_path, triage_fts.filename, triage_fts.ext, triage_fts.size, triage_fts.mtime, triage_fts.poster_rel, triage_fts.offline, triage_fts.ocr_text, COALESCE(d.state, \'undecided\') AS state, d.well_id'

export type TriageSort = 'scanned' | 'date-desc' | 'date-asc'

async function hasProposals(db: string): Promise<boolean> {
  const r = await query<{ n: number }>(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sorter_proposals'", [])
  if (!r[0] || Number(r[0].n) === 0) return false
  // the review columns arrive with the sorter store's migration; an older table lacks them
  const cols = await query<{ name: string }>(db, "SELECT name FROM pragma_table_info('sorter_proposals')", [])
  return cols.some((c) => c.name === 'throwaway_since')
}

/**
 * Browse/search the triage index. sort: scanned (default) | date-desc | date-asc (by file mtime).
 *
 * Review piles (ticket 08): an emptied item is gone, and an item in the review's Bin is no longer
 * findable. Which items those are comes from the review's pure clock (piles.ts via hiddenFromLists),
 * never a second date rule here; an unreadable or missing date keeps an item in Throwaway, listed.
 */
export async function listTriage(wellRoot: string, raw: string, state: string, sort: TriageSort = 'scanned', limit = 150, offset = 0, now = Date.now()): Promise<TriageRow[]> {
  const db = triageDb(wellRoot)
  if (!existsSync(db)) return []
  const withProposals = await hasProposals(db)
  const hidden = [...hiddenFromLists(wellRoot, now)]
  const conds = ["COALESCE(d.state, 'undecided') != 'emptied'"]
  if (hidden.length) conds.push(`triage_fts.hash NOT IN (${hidden.map(() => '?').join(',')})`)
  if (state && state !== 'all') conds.push(`COALESCE(d.state, 'undecided') = '${state.replace(/[^a-z]/g, '')}'`)
  const join = `triage_fts LEFT JOIN triage_decisions d ON d.hash = triage_fts.hash${withProposals ? ' LEFT JOIN sorter_proposals p ON p.hash = triage_fts.hash' : ''}`
  const cols = LIST_COLS + (withProposals ? ', d.decided_at, p.proposal, p.proposed_at, p.throwaway_since' : ', d.decided_at, NULL AS proposal, NULL AS proposed_at, NULL AS throwaway_since')
  const dateOrder = `ORDER BY CAST(triage_fts.mtime AS INTEGER) ${sort === 'date-asc' ? 'ASC' : 'DESC'}`
  const useDate = sort === 'date-asc' || sort === 'date-desc'
  if (raw && raw.trim().length >= 2) {
    const q = safeFtsQuery(raw)
    return query<TriageRow>(db, `SELECT ${cols} FROM ${join} WHERE triage_fts MATCH ? AND ${conds.join(' AND ')} ${useDate ? dateOrder : 'ORDER BY rank'} LIMIT ? OFFSET ?`, [q, ...hidden, limit, offset])
  }
  return query<TriageRow>(db, `SELECT ${cols} FROM ${join} WHERE ${conds.join(' AND ')} ${useDate ? dateOrder : 'ORDER BY triage_fts.scanned_at DESC'} LIMIT ? OFFSET ?`, [...hidden, limit, offset])
}

export async function triageCounts(wellRoot: string): Promise<TriageCounts> {
  const db = triageDb(wellRoot)
  const empty: TriageCounts = { undecided: 0, selected: 0, included: 0, excluded: 0, total: 0 }
  if (!existsSync(db)) return empty
  const rows = await query<{ state: string; n: number; hashes: number }>(
    db,
    `SELECT COALESCE(d.state, 'undecided') AS state, COUNT(*) AS n, COUNT(DISTINCT triage_fts.hash) AS hashes
     FROM triage_fts LEFT JOIN triage_decisions d ON d.hash = triage_fts.hash
     WHERE COALESCE(d.state, 'undecided') != 'emptied' GROUP BY state`,
    []
  )
  return tallyTriageStates(rows)
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
): Promise<{ state: string; refused?: string }> {
  await ensureTriage(wellRoot)
  const db = triageDb(wellRoot)
  // An 'emptied' marker (Empty Bin) is permanent: every write below is conditioned on it in SQL, so
  // neither reset nor a new decision can remove it, even if the item was emptied a moment ago.
  if (action === 'reset') {
    await run(db, "DELETE FROM triage_decisions WHERE hash = ? AND state != 'emptied'", [hash])
  } else {
    const state = action === 'exclude' ? 'excluded' : 'selected' // select = stage only; importSelectedTriage promotes
    await run(
      db,
      `INSERT INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, ?, ?, NULL)
       ON CONFLICT(hash) DO UPDATE SET state = excluded.state, decided_at = excluded.decided_at, well_id = NULL WHERE triage_decisions.state != 'emptied'`,
      [hash, state, new Date().toISOString()]
    )
  }
  const now = await query<{ state: string }>(db, 'SELECT state FROM triage_decisions WHERE hash = ?', [hash])
  if (now[0]?.state === 'emptied') return { state: 'emptied', refused: 'This screenshot was emptied from the Bin; it stays hidden for good and cannot be changed.' }
  return { state: now[0]?.state ?? 'undecided' }
}

export type TriageDecisionRow = { state: string; decidedAt: string | null; wellId: string | null }

/** His decision for one content hash, exactly as stored (null = undecided). */
export async function getTriageDecision(wellRoot: string, hash: string): Promise<TriageDecisionRow | null> {
  const db = triageDb(wellRoot)
  if (!existsSync(db)) return null
  await ensureTriage(wellRoot)
  const r = await query<{ state: string; decided_at: string | null; well_id: string | null }>(db, 'SELECT state, decided_at, well_id FROM triage_decisions WHERE hash = ?', [hash])
  return r[0] ? { state: r[0].state, decidedAt: r[0].decided_at ?? null, wellId: r[0].well_id ?? null } : null
}

/**
 * Write one decision exactly (review keep/throwaway, undo restoring the prior row, Empty Bin's
 * 'emptied' marker), or forget it with null. The review screen writes his choices through here,
 * the same table the Triage panel uses; the sorter never calls it.
 */
export async function putTriageDecision(wellRoot: string, hash: string, row: TriageDecisionRow | null): Promise<void> {
  await ensureTriage(wellRoot)
  const db = triageDb(wellRoot)
  // never over an 'emptied' marker (permanent)
  if (!row) {
    await run(db, "DELETE FROM triage_decisions WHERE hash = ? AND state != 'emptied'", [hash])
    return
  }
  await run(
    db,
    `INSERT INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(hash) DO UPDATE SET state = excluded.state, decided_at = excluded.decided_at, well_id = excluded.well_id WHERE triage_decisions.state != 'emptied'`,
    [hash, row.state, row.decidedAt, row.wellId]
  )
}

/** One Bin item as Empty Bin saw it: his decision at that moment (null = none). */
export type BinSnapshot = { hash: string; decision: TriageDecisionRow | null }

/**
 * Empty Bin's only write: the permanent 'emptied' marker, in one transaction. Each row is written
 * only if the item is still in the Bin at write time — his decision unchanged since the snapshot and
 * the 30-day clock (piles.ts) still run out. Anything that changed meanwhile (rescued, re-decided in
 * Triage) is left alone and reported. No file is touched; the well id is kept so a kept-then-binned
 * item's well record stays hidden rather than deleted.
 */
export function writeEmptiedMarkers(wellRoot: string, snapshot: BinSnapshot[], now: number): { emptied: string[]; changed: string[] } {
  const out = { emptied: [] as string[], changed: [] as string[] }
  if (!snapshot.length) return out
  const db = new DatabaseSync(triageDb(wellRoot))
  try {
    db.exec('PRAGMA busy_timeout=5000;')
    db.exec('CREATE TABLE IF NOT EXISTS triage_decisions (hash TEXT PRIMARY KEY, state TEXT NOT NULL, decided_at TEXT, well_id TEXT)')
    const hasSince = (db.prepare("SELECT name FROM pragma_table_info('sorter_proposals')").all() as Array<{ name: string }>).some((c) => c.name === 'throwaway_since')
    const getD = db.prepare('SELECT state, decided_at, well_id FROM triage_decisions WHERE hash = ?')
    const getP = db.prepare(`SELECT proposal, proposed_at, ${hasSince ? 'throwaway_since' : 'NULL AS throwaway_since'} FROM sorter_proposals WHERE hash = ?`)
    const put = db.prepare('INSERT OR REPLACE INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, ?, ?, ?)')
    const at = new Date(now).toISOString()
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const s of snapshot) {
        const d = getD.get(s.hash) as { state: string; decided_at: string | null; well_id: string | null } | undefined
        const was = s.decision
        const same = !d ? !was : Boolean(was) && d.state === was!.state && (d.decided_at ?? null) === was!.decidedAt && (d.well_id ?? null) === was!.wellId
        const p = getP.get(s.hash) as { proposal: ProposalLabel; proposed_at: string | null; throwaway_since: string | null } | undefined
        const stillBin =
          same && p && pileOf({ proposal: p.proposal, proposedAt: p.proposed_at, throwawaySince: p.throwaway_since, decision: d ? { state: d.state, decidedAt: d.decided_at } : null }, now).pile === 'bin'
        if (!stillBin) {
          out.changed.push(s.hash)
          continue
        }
        put.run(s.hash, 'emptied', at, d?.well_id ?? null)
        out.emptied.push(s.hash)
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  } finally {
    db.close()
  }
  return out
}

export type PromoteResult = {
  imported: Array<{ hash: string; wellId: string; relPath: string; created: boolean }>
  skipped: number
  gated: number
}

/**
 * Promote staged (state='selected') items into the well — all of them, or only `onlyHashes`.
 * Offline/missing files are skipped; a video over the 20 MB gate is skipped unless its hash is in
 * forceHashes. Imported items move to state='included' with their new well id; the rest stay staged.
 */
export async function promoteTriageHashes(
  archiveRoot: string,
  wellRoot: string,
  sourceRoot: string,
  onlyHashes: string[] | null,
  forceHashes: string[] = []
): Promise<PromoteResult> {
  await ensureTriage(wellRoot)
  const db = triageDb(wellRoot)
  if (onlyHashes && onlyHashes.length === 0) return { imported: [], skipped: 0, gated: 0 }
  const only = onlyHashes ? ` AND triage_fts.hash IN (${onlyHashes.map(() => '?').join(',')})` : ''
  // GROUP BY hash: decisions are keyed by content hash, but triage_fts is keyed by path, so a hash
  // with duplicate files JOINs to multiple rows. One row per hash avoids ingesting the same selected
  // item once per duplicate.
  const staged = await query<{ hash: string; kind: string; rel_path: string; offline: string; source: string }>(
    db,
    `SELECT triage_fts.hash AS hash, triage_fts.kind AS kind, triage_fts.rel_path AS rel_path, triage_fts.offline AS offline, triage_fts.source AS source
     FROM triage_fts JOIN triage_decisions d ON d.hash = triage_fts.hash
     WHERE d.state = 'selected'${only}
     GROUP BY triage_fts.hash`,
    onlyHashes ?? []
  )
  const enriched = staged.map((s) => {
    const abs = join(s.source || sourceRoot, s.rel_path)
    const missing = !existsSync(abs)
    const sizeBytes = missing ? 0 : statSync(abs).size
    // offline = OneDrive online-only placeholder (stored as '1' at scan time). It can't be ingested
    // (no local bytes), so it is skipped — a keyboard-select bypasses the card's offline-disabled button.
    return { hash: s.hash, kind: s.kind, offline: s.offline === '1', missing, sizeBytes, abs }
  })
  const plan = planSelectedImport(enriched, forceHashes, VIDEO_GATE_BYTES)
  const imported: PromoteResult['imported'] = []
  let failed = 0
  for (const hash of plan.toImport) {
    const row = enriched.find((e) => e.hash === hash)
    if (!row) continue
    const res = row.kind === 'video' ? await ingestVideo(archiveRoot, wellRoot, row.abs) : await ingestScreenshot(archiveRoot, wellRoot, row.abs, 'screenshot')
    if (res?.id) {
      // Link this well copy to its triage decision key only when that key is the hash ingest computed
      // from the bytes it actually imported. A stale scan hash (file replaced since its scan) would
      // otherwise let emptying the old content hide this different content. Ingest has already
      // recorded the real hash either way.
      const matches = res.sourceHash === hash
      if (matches) await recordWellSource(wellRoot, res.id, hash)
      else console.error(`[triage] ${row.abs}: scanned as ${hash} but imported as ${res.sourceHash || 'unknown'} — the file changed since its scan; not linked to the old hash`)
      // Ingest is async: the item may have been emptied from the Bin meanwhile. Like every other
      // decision write, this one never replaces an 'emptied' marker; such an item counts as skipped
      // (its well copy, if one was just made, is hidden by content identity — well.ts hiddenWellIds).
      await run(
        db,
        `INSERT INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, 'included', ?, ?)
         ON CONFLICT(hash) DO UPDATE SET state = excluded.state, decided_at = excluded.decided_at, well_id = excluded.well_id WHERE triage_decisions.state != 'emptied'`,
        // the decision names the well copy only when its key is the imported content; otherwise no well id
        [hash, new Date().toISOString(), matches ? res.id : null]
      )
      const now = await query<{ state: string }>(db, 'SELECT state FROM triage_decisions WHERE hash = ?', [hash])
      if (now[0]?.state === 'included') imported.push({ hash, wellId: res.id, relPath: res.relPath, created: res.created })
      else failed++
    } else {
      console.error(`[triage] import failed for ${row.abs} — ingest returned no id; left staged`)
      failed++
    }
  }
  return { imported, skipped: plan.skipped.length + failed, gated: plan.gated.length }
}

/**
 * Promote every staged (state='selected') item into the well (the Triage panel's Import). Idempotent:
 * a second run finds nothing still 'selected'.
 */
export async function importSelectedTriage(
  archiveRoot: string,
  wellRoot: string,
  sourceRoot: string,
  forceHashes: string[] = []
): Promise<{ imported: number; skipped: number; gated: number }> {
  const r = await promoteTriageHashes(archiveRoot, wellRoot, sourceRoot, null, forceHashes)
  return { imported: r.imported.length, skipped: r.skipped, gated: r.gated }
}
