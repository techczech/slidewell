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
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { query, run, safeFtsQuery } from './sqlite'
import { ingestScreenshot, ingestVideo, recordWellSource } from './well'
import { appKey, tallyTriageStates, planSelectedImport, type TriageCounts } from './triage-logic'
import { DatabaseSync } from 'node:sqlite'
import { pileOf, type ProposalLabel } from './review/piles'
import { hiddenFromLists } from './review/store'
import { ensureTriage, triageDb } from './triage-store'

export { downloadBackoffMs, scanTriageSource, type ScanListing, type ScanOptions } from './triage-scan'

/** Soft gate (ADR-0029): a video over this needs an explicit confirm before include. */
export const VIDEO_GATE_BYTES = 20 * 1024 * 1024

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
 *
 * `apps` (ticket 20): only screenshots from these apps; '' is "app not known". Names compare as
 * appKey does (trimmed, without case): the spellings in the index that match are worked out here and
 * the query names exactly those. Null or empty = every app.
 */
export async function listTriage(wellRoot: string, raw: string, state: string, sort: TriageSort = 'scanned', limit = 150, offset = 0, now = Date.now(), apps: string[] | null = null): Promise<TriageRow[]> {
  const db = triageDb(wellRoot)
  if (!existsSync(db)) return []
  const withProposals = await hasProposals(db)
  const hidden = [...hiddenFromLists(wellRoot, now)]
  const conds = ["COALESCE(d.state, 'undecided') != 'emptied'"]
  if (hidden.length) conds.push(`triage_fts.hash NOT IN (${hidden.map(() => '?').join(',')})`)
  if (state && state !== 'all') conds.push(`COALESCE(d.state, 'undecided') = '${state.replace(/[^a-z]/g, '')}'`)
  let spellings: string[] = []
  if (apps?.length) {
    const wanted = new Set(apps.map(appKey))
    const known = await query<{ app: string | null }>(db, "SELECT DISTINCT COALESCE(app, '') AS app FROM triage_fts", [])
    spellings = known.map((r) => String(r.app ?? '')).filter((a) => wanted.has(appKey(a)))
    if (!spellings.length) return []
    conds.push(`COALESCE(triage_fts.app, '') IN (${spellings.map(() => '?').join(',')})`)
  }
  const join = `triage_fts LEFT JOIN triage_decisions d ON d.hash = triage_fts.hash${withProposals ? ' LEFT JOIN sorter_proposals p ON p.hash = triage_fts.hash' : ''}`
  const cols = LIST_COLS + (withProposals ? ', d.decided_at, p.proposal, p.proposed_at, p.throwaway_since' : ', d.decided_at, NULL AS proposal, NULL AS proposed_at, NULL AS throwaway_since')
  const dateOrder = `ORDER BY CAST(triage_fts.mtime AS INTEGER) ${sort === 'date-asc' ? 'ASC' : 'DESC'}`
  const useDate = sort === 'date-asc' || sort === 'date-desc'
  if (raw && raw.trim().length >= 2) {
    const q = safeFtsQuery(raw)
    return query<TriageRow>(db, `SELECT ${cols} FROM ${join} WHERE triage_fts MATCH ? AND ${conds.join(' AND ')} ${useDate ? dateOrder : 'ORDER BY rank'} LIMIT ? OFFSET ?`, [q, ...hidden, ...spellings, limit, offset])
  }
  return query<TriageRow>(db, `SELECT ${cols} FROM ${join} WHERE ${conds.join(' AND ')} ${useDate ? dateOrder : 'ORDER BY triage_fts.scanned_at DESC'} LIMIT ? OFFSET ?`, [...hidden, ...spellings, limit, offset])
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

/**
 * Set one scan row's `offline` flag (a cloud placeholder or not) to what the file is now, after Review asked the cloud
 * provider for it (review/download.ts). Only that flag of the rows at this path changes, and only when it differs; the
 * hash, the text read from the picture and every other column stay as the scan wrote them (a later scan of a changed
 * file rewrites the row as usual). Returns how many rows changed. No file is read or touched.
 */
export function setTriageOffline(wellRoot: string, source: string, relPath: string, offline: boolean): number {
  const file = triageDb(wellRoot)
  if (!existsSync(file)) return 0
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA busy_timeout=5000;')
    const flag = offline ? '1' : '0'
    const r = db.prepare('UPDATE triage_fts SET offline = ? WHERE source = ? AND rel_path = ? AND offline IS NOT ?').run(flag, source, relPath, flag)
    return Number(r.changes)
  } finally {
    db.close()
  }
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

/**
 * One Review answer as the rescue saw it (review/rescue.ts): his decision and the sorter-store answer
 * mark at that moment. `reset`: put this one back; false = only checked (kept-and-imported, emptied).
 */
export type AnswerSnapshot = { hash: string; decision: TriageDecisionRow; answer: { answer: string; answeredAt: string }; reset: boolean }

/**
 * Put Review answers back to undecided (review/rescue.ts), in one BEGIN IMMEDIATE transaction. First
 * every item of the confirmed set (`reset` or not) is read again; each must still have exactly the
 * decision (state, decided_at, well_id) and answer mark (answer, answered_at) of the snapshot. Any
 * difference: nothing is written and the differing items are named in `changed`. Otherwise, for each
 * `reset` item, the same two writes as Triage's reset (U) and Review's undo to "no answer": the
 * decision row is forgotten (never an 'emptied' one) and the answer mark is cleared, with the picture
 * recorded at answer time. No file and no well record is touched.
 * Only the snapshot's members are compared, not full-set equality: a Review answer added meanwhile is not looked
 * for. Safe because answer marks are written only by ReviewService, one call at a time, and rescue() rebuilds the
 * snapshot and compares the token inside that same queued call; this depends on rescue running inside the service
 * queue (rescue.ts refuses to run outside it).
 */
export function resetReviewAnswers(wellRoot: string, snapshot: AnswerSnapshot[]): { reset: string[]; changed: string[] } {
  if (!snapshot.length) return { reset: [], changed: [] }
  const db = new DatabaseSync(triageDb(wellRoot))
  try {
    db.exec('PRAGMA busy_timeout=5000;')
    const picCol = (db.prepare("SELECT 1 FROM pragma_table_info('sorter_proposals') WHERE name = 'answered_picture'").get() as unknown) !== undefined
    const getD = db.prepare('SELECT state, decided_at, well_id FROM triage_decisions WHERE hash = ?')
    const getA = db.prepare('SELECT answer, answered_at FROM sorter_proposals WHERE hash = ?')
    const forget = db.prepare("DELETE FROM triage_decisions WHERE hash = ? AND state != 'emptied'")
    const unanswer = db.prepare(picCol ? 'UPDATE sorter_proposals SET answer = NULL, answered_at = NULL, answered_picture = NULL WHERE hash = ?' : 'UPDATE sorter_proposals SET answer = NULL, answered_at = NULL WHERE hash = ?')
    const changed: string[] = []
    const targets: string[] = []
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const s of snapshot) {
        const d = getD.get(s.hash) as { state: string; decided_at: string | null; well_id: string | null } | undefined
        const a = getA.get(s.hash) as { answer: string | null; answered_at: string | null } | undefined
        const same =
          Boolean(d && a) &&
          d!.state === s.decision.state &&
          (d!.decided_at ?? null) === s.decision.decidedAt &&
          (d!.well_id ?? null) === s.decision.wellId &&
          a!.answer === s.answer.answer &&
          a!.answered_at === s.answer.answeredAt
        if (!same || (s.reset && d!.state === 'emptied')) changed.push(s.hash)
        else if (s.reset) targets.push(s.hash)
      }
      if (changed.length) {
        db.exec('ROLLBACK')
        return { reset: [], changed }
      }
      for (const h of targets) {
        forget.run(h)
        unanswer.run(h)
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    return { reset: targets, changed: [] }
  } finally {
    db.close()
  }
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
  forceHashes: string[] = [],
  onStep?: (done: number, total: number) => void
): Promise<PromoteResult> {
  await ensureTriage(wellRoot)
  const db = triageDb(wellRoot)
  if (onlyHashes && onlyHashes.length === 0) return { imported: [], skipped: 0, gated: 0 }
  const only = onlyHashes ? ` AND triage_fts.hash IN (${onlyHashes.map(() => '?').join(',')})` : ''
  // A decision can have more than one path. Choose a readable copy before importing
  // once per hash, including when another copy is still at an unavailable former path.
  const staged = await query<{ hash: string; kind: string; rel_path: string; offline: string; source: string; content_hash: string | null }>(
    db,
    `SELECT triage_fts.hash AS hash, triage_fts.kind AS kind, triage_fts.rel_path AS rel_path, triage_fts.offline AS offline, triage_fts.source AS source, m.content_hash
     FROM triage_fts JOIN triage_decisions d ON d.hash = triage_fts.hash
     LEFT JOIN triage_relocation_observations m ON m.triage_rowid = triage_fts.rowid
       AND m.hash = triage_fts.hash AND m.scanned_at = triage_fts.scanned_at
     WHERE d.state = 'selected'${only}`,
    onlyHashes ?? []
  )
  const copies = new Map<string, { hash: string; kind: string; offline: boolean; missing: boolean; sizeBytes: number; abs: string; contentHash: string | null }>()
  for (const s of staged) {
    const root = s.source || sourceRoot
    const abs = root ? join(root, s.rel_path) : ''
    let size: number | undefined
    try {
      if (abs) size = statSync(abs, { throwIfNoEntry: false })?.size
    } catch {
      console.error(`[triage] import failed for ${abs} — could not read the file; left staged`)
    }
    const missing = size === undefined
    const sizeBytes = size ?? 0
    // offline = OneDrive online-only placeholder (stored as '1' at scan time). It can't be ingested
    // (no local bytes), so it is skipped — a keyboard-select bypasses the card's offline-disabled button.
    const offline = s.offline === '1'
    const existing = copies.get(s.hash)
    if (!existing || ((existing.missing || existing.offline) && !missing && !offline)) {
      copies.set(s.hash, { hash: s.hash, kind: s.kind, offline, missing, sizeBytes, abs, contentHash: s.content_hash })
    }
  }
  const plan = planSelectedImport([...copies.values()], forceHashes, VIDEO_GATE_BYTES)
  const imported: PromoteResult['imported'] = []
  let failed = 0
  let handled = 0
  onStep?.(0, plan.toImport.length)
  for (const hash of plan.toImport) {
    const row = copies.get(hash)
    if (!row) continue
    try {
      const res = row.kind === 'video' ? await ingestVideo(archiveRoot, wellRoot, row.abs) : await ingestScreenshot(archiveRoot, wellRoot, row.abs, 'screenshot')
      if (res?.id) {
        // A former placeholder may have a verified content hash under its retained decision key.
        // Compare the bytes ingest read to that verified hash, just as for an ordinary scan.
        const matches = res.sourceHash === (row.contentHash ?? hash)
        if (matches) await recordWellSource(wellRoot, res.id, hash)
        else console.error(`[triage] ${row.abs}: scanned as ${hash} but imported as ${res.sourceHash || 'unknown'} — the file changed since its scan; not linked to the old hash`)
        // Ingest is async: the item may have been emptied from the Bin meanwhile. Like every other
        // decision write, this one never replaces an 'emptied' marker; such an item counts as skipped
        // (its well copy, if one was just made, is hidden by content identity — well.ts hiddenWellIds).
        await run(
          db,
          `INSERT INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, 'included', ?, ?)
           ON CONFLICT(hash) DO UPDATE SET state = excluded.state, decided_at = excluded.decided_at, well_id = excluded.well_id WHERE triage_decisions.state != 'emptied'`,
          // The decision names a well copy only after the imported content verifies.
          [hash, new Date().toISOString(), matches ? res.id : null]
        )
        const now = await query<{ state: string }>(db, 'SELECT state FROM triage_decisions WHERE hash = ?', [hash])
        if (now[0]?.state === 'included') imported.push({ hash, wellId: res.id, relPath: res.relPath, created: res.created })
        else failed++
      } else {
        console.error(`[triage] import failed for ${row.abs} — ingest returned no id; left staged`)
        failed++
      }
    } catch {
      console.error(`[triage] import failed for ${row.abs} — the copy or index could not be saved`)
      failed++
    }
    onStep?.(++handled, plan.toImport.length)
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
  forceHashes: string[] = [],
  onStep?: (done: number, total: number) => void
): Promise<{ imported: number; skipped: number; gated: number }> {
  const r = await promoteTriageHashes(archiveRoot, wellRoot, sourceRoot, null, forceHashes, onStep)
  return { imported: r.imported.length, skipped: r.skipped, gated: r.gated }
}
