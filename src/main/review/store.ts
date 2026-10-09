/**
 * What the review screen reads (ticket 08): every screenshot the sorter made a proposal for, with his
 * decision (if any) and the facts to show on a card. Read-only; writes go through triage.ts (his
 * decisions), sorter/store.ts (answer marks, proposal records) and well.ts.
 *
 * triage_fts is FTS5 keyed by path (its hash column cannot be indexed), so it is read once per call
 * into a map rather than joined.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pileOf, type PileFacts, type ProposalLabel } from './piles'

export type ReviewFile = {
  source: string
  relPath: string
  filename: string
  app: string
  windowTitle: string
  takenAt: string
  kind: string
  offline: boolean
  posterRel: string
  mtime: number
}

export type ReviewRow = PileFacts & {
  hash: string
  proposal: ProposalLabel
  confidence: number
  reason: string
  answeredAt: string | null
  answer: string | null
  decision: { state: string; decidedAt: string | null; wellId: string | null } | null
  file: ReviewFile | null
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name))
}
function hasColumn(db: DatabaseSync, table: string, col: string): boolean {
  return (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).some((c) => c.name === col)
}

type ProposalJoin = {
  hash: string
  proposal: ProposalLabel
  confidence: number
  reason: string
  proposed_at: string | null
  throwaway_since: string | null
  answered_at: string | null
  answer: string | null
  state: string | null
  decided_at: string | null
  well_id: string | null
}

type FileRow = { hash: string; source: string | null; rel_path: string; filename: string | null; app: string | null; window_title: string | null; taken_at: string | null; kind: string; offline: string; poster_rel: string | null; mtime: string | null }

export function readReviewRows(wellRoot: string): ReviewRow[] {
  const file = join(wellRoot, 'triage.db')
  if (!existsSync(file)) return []
  const db = new DatabaseSync(file, { readOnly: true })
  db.exec('PRAGMA busy_timeout=5000;')
  try {
    if (!hasTable(db, 'sorter_proposals')) return []
    const decisions = hasTable(db, 'triage_decisions')
    const reviewCols = hasColumn(db, 'sorter_proposals', 'throwaway_since')
    const rows = db
      .prepare(
        `SELECT p.hash AS hash, p.proposal AS proposal, p.confidence AS confidence, p.reason AS reason, p.proposed_at AS proposed_at,
           ${reviewCols ? 'p.throwaway_since, p.answered_at, p.answer' : "CASE WHEN p.proposal = 'throwaway' THEN p.proposed_at END AS throwaway_since, NULL AS answered_at, NULL AS answer"},
           ${decisions ? 'd.state AS state, d.decided_at AS decided_at, d.well_id AS well_id' : 'NULL AS state, NULL AS decided_at, NULL AS well_id'}
         FROM sorter_proposals p ${decisions ? 'LEFT JOIN triage_decisions d ON d.hash = p.hash' : ''}`
      )
      .all() as ProposalJoin[]
    const files = new Map<string, FileRow>()
    if (hasTable(db, 'triage_fts')) {
      const all = db.prepare('SELECT hash, source, rel_path, filename, app, window_title, taken_at, kind, offline, poster_rel, mtime FROM triage_fts').all() as FileRow[]
      for (const f of all) {
        const cur = files.get(f.hash)
        if (!cur || (cur.offline === '1' && f.offline !== '1')) files.set(f.hash, f) // a downloaded copy wins
      }
    }
    return rows.map((r) => {
      const f = files.get(r.hash)
      return {
        hash: r.hash,
        proposal: r.proposal,
        confidence: Number(r.confidence),
        reason: r.reason,
        proposedAt: r.proposed_at,
        throwawaySince: r.throwaway_since,
        answeredAt: r.answered_at,
        answer: r.answer,
        decision: r.state ? { state: r.state, decidedAt: r.decided_at, wellId: r.well_id } : null,
        file: f
          ? {
              source: f.source ?? '',
              relPath: f.rel_path,
              filename: f.filename ?? f.rel_path,
              app: f.app ?? '',
              windowTitle: f.window_title ?? '',
              takenAt: f.taken_at ?? '',
              kind: f.kind,
              offline: f.offline === '1',
              posterRel: f.poster_rel ?? '',
              mtime: Number(f.mtime) || 0
            }
          : null
      }
    })
  } finally {
    db.close()
  }
}

/** Newest first: the time in the file name, else the file's modified time. */
export function newestFirst(a: ReviewRow, b: ReviewRow): number {
  const ta = a.file?.takenAt ? Date.parse(a.file.takenAt) : a.file?.mtime ?? 0
  const tb = b.file?.takenAt ? Date.parse(b.file.takenAt) : b.file?.mtime ?? 0
  return (tb || 0) - (ta || 0)
}

/**
 * Hashes that lists outside review must not show: items in the Bin or emptied, decided by the same
 * pure clock as the piles (piles.ts). Reads proposals and decisions only.
 */
export function hiddenFromLists(wellRoot: string, now: number): Set<string> {
  const out = new Set<string>()
  const file = join(wellRoot, 'triage.db')
  if (!existsSync(file)) return out
  const db = new DatabaseSync(file, { readOnly: true })
  db.exec('PRAGMA busy_timeout=5000;')
  try {
    if (!hasTable(db, 'sorter_proposals')) return out
    const decisions = hasTable(db, 'triage_decisions')
    const since = hasColumn(db, 'sorter_proposals', 'throwaway_since') ? 'p.throwaway_since' : "CASE WHEN p.proposal = 'throwaway' THEN p.proposed_at END"
    const rows = db
      .prepare(
        `SELECT p.hash AS hash, p.proposal AS proposal, p.proposed_at AS proposed_at, ${since} AS throwaway_since,
           ${decisions ? 'd.state AS state, d.decided_at AS decided_at' : 'NULL AS state, NULL AS decided_at'}
         FROM sorter_proposals p ${decisions ? 'LEFT JOIN triage_decisions d ON d.hash = p.hash' : ''}`
      )
      .all() as Array<{ hash: string; proposal: ProposalLabel; proposed_at: string | null; throwaway_since: string | null; state: string | null; decided_at: string | null }>
    for (const r of rows) {
      const pile = pileOf({ proposal: r.proposal, proposedAt: r.proposed_at, throwawaySince: r.throwaway_since, decision: r.state ? { state: r.state, decidedAt: r.decided_at } : null }, now).pile
      if (pile === 'bin' || pile === 'gone') out.add(r.hash)
    }
    return out
  } finally {
    db.close()
  }
}
