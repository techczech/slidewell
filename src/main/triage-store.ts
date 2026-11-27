import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { query, run } from './sqlite'

export function triageDb(wellRoot: string): string {
  return join(wellRoot, 'triage.db')
}
export function postersDir(wellRoot: string): string {
  return join(wellRoot, '_triage-posters')
}

export async function ensureTriage(wellRoot: string): Promise<void> {
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
  await run(db, `CREATE TABLE IF NOT EXISTS triage_relocation_observations (
    triage_rowid INTEGER PRIMARY KEY, hash TEXT NOT NULL, scanned_at TEXT NOT NULL,
    size TEXT NOT NULL, mtime TEXT NOT NULL, content_hash TEXT
  );
  CREATE TABLE IF NOT EXISTS triage_decisions (hash TEXT PRIMARY KEY, state TEXT NOT NULL, decided_at TEXT, well_id TEXT)`)
  // per-file download backoff (ticket 15): a file that keeps failing waits longer each time
  await run(db, `CREATE TABLE IF NOT EXISTS download_backoff (source TEXT NOT NULL, rel_path TEXT NOT NULL, sig TEXT NOT NULL, failures INTEGER NOT NULL, last_attempt INTEGER NOT NULL, PRIMARY KEY (source, rel_path))`)
}
