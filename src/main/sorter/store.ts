/**
 * The sorter's data: what it reads (his labelled history and the undecided screenshots, from
 * triage.db and well.db) and what it writes (its own proposals and trained models, in triage.db).
 *
 * Writes go ONLY to two sorter tables in triage.db. His own decisions (triage_decisions) are read,
 * never written: a proposal sits beside a decision, it never replaces or imitates one.
 *
 *   sorter_proposals(hash TEXT PRIMARY KEY,           triage content hash (same key as triage_decisions)
 *                    proposal TEXT,                    keep | throwaway | doubtful
 *                    confidence REAL, p_keep REAL,     probability of the proposal; combined p(keep)
 *                    reason TEXT, rule TEXT,           plain-words reason; rule name or NULL
 *                    sorter_version TEXT, model_id TEXT, proposed_at TEXT)
 *   sorter_models(id TEXT PRIMARY KEY, trained_at TEXT, sorter_version TEXT,
 *                 model TEXT (classifier JSON), report TEXT (accuracy report JSON))
 *
 * Image embeddings live in picture-search.db (kind 'triage', id `triage:<hash>`), see vector-store.ts.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { triageImageId, wellImageId, type IndexItem } from '../picture-search/vector-store'
import type { ShotFacts } from './rules'
import type { Truth } from './accuracy'
import type { Classifier } from './classifier'
import type { Proposal } from './decide'

const IMAGE_EXT = /\.(webp|png|jpe?g|gif|bmp|tiff?)$/i

/** One screenshot the sorter looks at: its facts for the rules and the image to embed (if readable). */
export type Shot = {
  /** Stable key for splitting: `h:<triage hash>` or `w:<well id>`. */
  key: string
  hash: string | null
  truth?: Truth
  facts: ShotFacts
  image: IndexItem | null
  /** A kept screenshot whose original is gone; the well's own (re-encoded) copy is embedded instead. */
  fromWellCopy: boolean
}

export type ProposalRow = { hash: string; proposal: Proposal; confidence: number; pKeep: number; reason: string; rule: string | null }

export type ModelRecord<R> = { id: string; trainedAt: string; sorterVersion: string; model: Classifier; report: R }

export type PendingCounts = { keep: number; throwaway: number; doubtful: number; lastProposedAt: string | null }

type TriageJoinRow = { hash: string; source: string | null; rel_path: string | null; filename: string | null; app: string | null; window_title: string | null; ocr_text: string | null; state?: string; well_id?: string | null }

/** A local file we may read: present, non-empty, and not an online-only placeholder (never fetch). */
function localFile(p: string): { size: number; mtimeMs: number } | null {
  try {
    const st = statSync(p)
    if (!st.isFile() || st.size === 0 || st.blocks === 0) return null
    return { size: st.size, mtimeMs: Math.round(st.mtimeMs) }
  } catch {
    return null
  }
}

function triageItem(r: TriageJoinRow): IndexItem | null {
  if (!r.source || !r.rel_path || !IMAGE_EXT.test(r.rel_path)) return null
  const path = join(r.source, r.rel_path)
  const f = localFile(path)
  return f ? { id: triageImageId(r.hash), kind: 'triage', path, size: f.size, mtimeMs: f.mtimeMs } : null
}

const factsOf = (r: TriageJoinRow | undefined, ocrFallback = ''): ShotFacts => ({
  app: r?.app ?? '',
  windowTitle: r?.window_title ?? '',
  ocrText: r?.ocr_text || ocrFallback,
  filename: r?.filename ?? ''
})

function openRead(file: string): DatabaseSync | null {
  if (!existsSync(file)) return null
  const db = new DatabaseSync(file, { readOnly: true })
  db.exec('PRAGMA busy_timeout=5000;')
  return db
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name))
}

/** Group join rows by hash; first row whose image is readable wins, else the first row. */
function byHash(rows: TriageJoinRow[]): Map<string, { row: TriageJoinRow; image: IndexItem | null }> {
  const out = new Map<string, { row: TriageJoinRow; image: IndexItem | null }>()
  for (const r of rows) {
    const cur = out.get(r.hash)
    if (cur?.image) continue
    const image = triageItem(r)
    if (!cur || image) out.set(r.hash, { row: r, image })
  }
  return out
}

const TRIAGE_COLS = 'f.source, f.rel_path, f.filename, f.app, f.window_title, f.ocr_text'

/**
 * His labelled history. keep = every screenshot in the well (source 'screenshot') plus triage
 * `included`; throwaway = triage `excluded`. A kept screenshot is embedded from its triage original
 * when that file is still here, else from the well's copy. Binned screenshots whose file is gone
 * have nothing to embed and come back with image null.
 */
export function loadLabelled(wellRoot: string): Shot[] {
  const tdb = openRead(join(wellRoot, 'triage.db'))
  const wdb = openRead(join(wellRoot, 'well.db'))
  try {
    const decided: TriageJoinRow[] =
      tdb && hasTable(tdb, 'triage_decisions') && hasTable(tdb, 'triage_fts')
        ? (tdb
            .prepare(
              `SELECT d.hash AS hash, d.state AS state, d.well_id AS well_id, ${TRIAGE_COLS}
               FROM triage_decisions d LEFT JOIN triage_fts f ON f.hash = d.hash AND f.kind = 'image' AND f.offline = '0'
               WHERE d.state IN ('included', 'excluded')`
            )
            .all() as TriageJoinRow[])
        : []
    const wellShots =
      wdb && hasTable(wdb, 'well_fts')
        ? (wdb.prepare("SELECT id, rel_path, ocr_text FROM well_fts WHERE source = 'screenshot' AND root = 'well'").all() as Array<{ id: string; rel_path: string; ocr_text: string | null }>)
        : []
    const groups = byHash(decided)
    const includedByWell = new Map<string, string>() // well id → triage hash
    for (const [hash, g] of groups) if (g.row.state === 'included' && g.row.well_id) includedByWell.set(g.row.well_id, hash)

    const out: Shot[] = []
    const usedHashes = new Set<string>()
    for (const w of wellShots) {
      if (!IMAGE_EXT.test(w.rel_path)) continue
      const hash = includedByWell.get(w.id) ?? null
      const g = hash ? groups.get(hash) : undefined
      if (hash) usedHashes.add(hash)
      let image = g?.image ?? null
      let fromWellCopy = false
      if (!image) {
        const path = join(wellRoot, w.rel_path)
        const f = localFile(path)
        if (f) {
          image = { id: wellImageId(w.id), kind: 'well-image', path, size: f.size, mtimeMs: f.mtimeMs, wellId: w.id }
          fromWellCopy = true
        }
      }
      out.push({ key: hash ? `h:${hash}` : `w:${w.id}`, hash, truth: 'keep', facts: factsOf(g?.row, w.ocr_text ?? ''), image, fromWellCopy })
    }
    for (const [hash, g] of groups) {
      if (usedHashes.has(hash)) continue
      if (g.row.state === 'included') out.push({ key: `h:${hash}`, hash, truth: 'keep', facts: factsOf(g.row), image: g.image, fromWellCopy: false })
      else if (g.row.state === 'excluded') out.push({ key: `h:${hash}`, hash, truth: 'throwaway', facts: factsOf(g.row), image: g.image, fromWellCopy: false })
    }
    return out
  } finally {
    tdb?.close()
    wdb?.close()
  }
}

/** Screenshots in triage with no decision of his (pictures only; videos and placeholders skipped). */
export function loadUndecided(wellRoot: string): Shot[] {
  const tdb = openRead(join(wellRoot, 'triage.db'))
  if (!tdb) return []
  try {
    if (!hasTable(tdb, 'triage_fts')) return []
    const decisions = hasTable(tdb, 'triage_decisions')
    const rows = tdb
      .prepare(
        `SELECT f.hash AS hash, ${TRIAGE_COLS} FROM triage_fts f
         ${decisions ? 'LEFT JOIN triage_decisions d ON d.hash = f.hash' : ''}
         WHERE f.kind = 'image' AND f.offline = '0' ${decisions ? 'AND d.hash IS NULL' : ''}`
      )
      .all() as TriageJoinRow[]
    return [...byHash(rows)].map(([hash, g]) => ({ key: `h:${hash}`, hash, facts: factsOf(g.row), image: g.image, fromWellCopy: false }))
  } finally {
    tdb.close()
  }
}

/** The sorter's own tables in triage.db: proposals and trained models. */
export class SorterStore {
  private db: DatabaseSync

  constructor(wellRoot: string) {
    this.db = new DatabaseSync(join(wellRoot, 'triage.db'))
    // triage.db stays in rollback-journal mode (its readers open it read-only; see triage.ts)
    this.db.exec('PRAGMA busy_timeout=5000;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sorter_proposals (
        hash TEXT PRIMARY KEY,
        proposal TEXT NOT NULL CHECK (proposal IN ('keep', 'throwaway', 'doubtful')),
        confidence REAL NOT NULL,
        p_keep REAL NOT NULL,
        reason TEXT NOT NULL,
        rule TEXT,
        sorter_version TEXT NOT NULL,
        model_id TEXT,
        proposed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sorter_models (
        id TEXT PRIMARY KEY,
        trained_at TEXT NOT NULL,
        sorter_version TEXT NOT NULL,
        model TEXT NOT NULL,
        report TEXT NOT NULL
      );
    `)
  }

  saveModel<R>(rec: ModelRecord<R>): void {
    this.db.prepare('INSERT OR REPLACE INTO sorter_models (id, trained_at, sorter_version, model, report) VALUES (?, ?, ?, ?, ?)').run(rec.id, rec.trainedAt, rec.sorterVersion, JSON.stringify(rec.model), JSON.stringify(rec.report))
  }

  latestModel<R>(): ModelRecord<R> | null {
    const r = this.db.prepare('SELECT id, trained_at, sorter_version, model, report FROM sorter_models ORDER BY trained_at DESC LIMIT 1').get() as
      | { id: string; trained_at: string; sorter_version: string; model: string; report: string }
      | undefined
    return r ? { id: r.id, trainedAt: r.trained_at, sorterVersion: r.sorter_version, model: JSON.parse(r.model), report: JSON.parse(r.report) } : null
  }

  /** Record proposals (one transaction). Never touches triage_decisions. */
  writeProposals(rows: ProposalRow[], sorterVersion: string, modelId: string | null): void {
    if (!rows.length) return
    const now = new Date().toISOString()
    const put = this.db.prepare(
      `INSERT INTO sorter_proposals (hash, proposal, confidence, p_keep, reason, rule, sorter_version, model_id, proposed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET proposal = excluded.proposal, confidence = excluded.confidence, p_keep = excluded.p_keep,
         reason = excluded.reason, rule = excluded.rule, sorter_version = excluded.sorter_version, model_id = excluded.model_id, proposed_at = excluded.proposed_at`
    )
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const r of rows) put.run(r.hash, r.proposal, r.confidence, r.pKeep, r.reason, r.rule, sorterVersion, modelId, now)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /** Proposals for screenshots he has still not decided, by label. */
  pendingCounts(): PendingCounts {
    const decisions = hasTable(this.db, 'triage_decisions')
    const rows = this.db
      .prepare(
        `SELECT p.proposal AS proposal, COUNT(*) AS n, MAX(p.proposed_at) AS last FROM sorter_proposals p
         ${decisions ? 'LEFT JOIN triage_decisions d ON d.hash = p.hash WHERE d.hash IS NULL' : ''} GROUP BY p.proposal`
      )
      .all() as Array<{ proposal: Proposal; n: number; last: string | null }>
    const out: PendingCounts = { keep: 0, throwaway: 0, doubtful: 0, lastProposedAt: null }
    for (const r of rows) {
      out[r.proposal] = Number(r.n)
      if (r.last && (!out.lastProposedAt || r.last > out.lastProposedAt)) out.lastProposedAt = r.last
    }
    return out
  }

  close(): void {
    this.db.close()
  }
}
