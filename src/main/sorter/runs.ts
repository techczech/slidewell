/**
 * Sort runs (ticket 20): every sort on this Mac, manual or nightly, as a record, and the three piles
 * of one run for the Auto sorting tab.
 *
 *   sorter_runs(id TEXT PRIMARY KEY, started_at TEXT, finished_at TEXT,   finished_at NULL while it runs
 *               period TEXT, trigger TEXT,                                 7d | 30d | 90d | all; manual | nightly
 *               sorted INTEGER, keep INTEGER, throwaway INTEGER, doubtful INTEGER)   as the sort ended
 *
 * in triage.db beside sorter_proposals, whose run_id names the run that last proposed each screenshot
 * (store.ts writes it). A screenshot sorted again later is in its latest run only; a cloud answer
 * changes its row in place and leaves it in its run. The newest RUNS_KEPT runs are kept (the cap is
 * applied when a run starts and again when it ends); an older
 * run's record is dropped and its id stays on its rows, where nothing reads it.
 *
 * The piles are derived, never stored: kept, thrown away and unsure. A card sits where his own
 * decision puts it when he has made one (selected or included = kept, excluded = thrown away), else
 * where the sorter's proposal does. Moving a card across is his decision through the Triage panel's
 * own decide path (triage.ts); nothing here writes one. Reads only, apart from the three table
 * functions the sorter store calls.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SortPeriod, SortRun, SortRunCard, SortRunPage, SortRunPile, SortRunPiles } from '../../preload'
import { keysetPage, pileKey, type PileKey, type ProposalLabel } from '../review/piles'
import { readReviewRows, timeOf, type ReviewRow } from '../review/store'
import { isSortPeriod } from './period'

/** How many runs are kept, newest first. */
export const RUNS_KEPT = 20

export type RunTrigger = 'manual' | 'nightly'
export type RunStart = { id: string; startedAt: string; period: SortPeriod; trigger: RunTrigger }
export type RunEnd = { finishedAt: string; counts: { sorted: number; keep: number; throwaway: number; doubtful: number } }

export const RUN_ID = /^[A-Za-z0-9:._-]{1,80}$/

/** A new run id: the start time and a random tail (two sorts can start in the same millisecond in tests). */
export function newRunId(startedAt: Date): string {
  return `run-${startedAt.toISOString()}-${Math.random().toString(36).slice(2, 8)}`
}

export function ensureRunsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sorter_runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      period TEXT NOT NULL,
      trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'nightly')),
      sorted INTEGER NOT NULL DEFAULT 0,
      keep INTEGER NOT NULL DEFAULT 0,
      throwaway INTEGER NOT NULL DEFAULT 0,
      doubtful INTEGER NOT NULL DEFAULT 0
    )`)
}

/**
 * A run starts: its record goes in and the cap is applied in the same transaction, so runs that never
 * finish (the app was quit mid-sort) cannot pile up. The run just started always stays, with the
 * newest RUNS_KEPT - 1 others (it is the newest unless the clock went back).
 */
export function startRun(db: DatabaseSync, r: RunStart): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('INSERT INTO sorter_runs (id, started_at, period, trigger) VALUES (?, ?, ?, ?)').run(r.id, r.startedAt, r.period, r.trigger)
    db.prepare('DELETE FROM sorter_runs WHERE id != ? AND id NOT IN (SELECT id FROM sorter_runs WHERE id != ? ORDER BY started_at DESC, id DESC LIMIT ?)').run(r.id, r.id, RUNS_KEPT - 1)
    db.exec('COMMIT')
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* the failed statement already ended the transaction */
    }
    throw e
  }
}

/** The run's numbers as it ended, and the cap: all but the newest RUNS_KEPT records go (one transaction). */
export function finishRun(db: DatabaseSync, id: string, end: RunEnd): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE sorter_runs SET finished_at = ?, sorted = ?, keep = ?, throwaway = ?, doubtful = ? WHERE id = ?').run(end.finishedAt, end.counts.sorted, end.counts.keep, end.counts.throwaway, end.counts.doubtful, id)
    db.prepare('DELETE FROM sorter_runs WHERE id NOT IN (SELECT id FROM sorter_runs ORDER BY started_at DESC, id DESC LIMIT ?)').run(RUNS_KEPT)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/**
 * Below these a card is drawn with the low-confidence marking: a kept or thrown-away proposal only
 * just over its threshold (DEFAULT_THRESHOLDS: keep 0.7, throwaway 0.9), an unsure one close to even.
 */
export const LOW_CONFIDENCE_BELOW: Record<ProposalLabel, number> = { keep: 0.8, throwaway: 0.95, doubtful: 0.6 }

export function isLowConfidence(proposal: ProposalLabel, confidence: number): boolean {
  return confidence < LOW_CONFIDENCE_BELOW[proposal]
}

/** Where a sorted screenshot is now; null when it was emptied from the Bin (in no pile). */
export function runPileOf(r: Pick<ReviewRow, 'proposal' | 'decision'>): SortRunPile | null {
  const state = r.decision?.state
  if (state === 'emptied') return null
  if (state === 'selected' || state === 'included') return 'kept'
  if (state === 'excluded') return 'throwaway'
  return r.proposal === 'keep' ? 'kept' : r.proposal === 'throwaway' ? 'throwaway' : 'unsure'
}

type RunRow = { id: string; started_at: string; finished_at: string | null; period: string; trigger: string; sorted: number; keep: number; throwaway: number; doubtful: number }
type Item = { row: ReviewRow; pile: SortRunPile }

function readRunRows(wellRoot: string): RunRow[] {
  const file = join(wellRoot, 'triage.db')
  if (!existsSync(file)) return []
  const db = new DatabaseSync(file, { readOnly: true })
  db.exec('PRAGMA busy_timeout=5000;')
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sorter_runs'").get()) return []
    return db.prepare('SELECT id, started_at, finished_at, period, trigger, sorted, keep, throwaway, doubtful FROM sorter_runs ORDER BY started_at DESC, id DESC LIMIT ?').all(RUNS_KEPT) as RunRow[]
  } finally {
    db.close()
  }
}

function itemsByRun(wellRoot: string): Map<string, Item[]> {
  const out = new Map<string, Item[]>()
  for (const row of readReviewRows(wellRoot)) {
    const pile = row.runId ? runPileOf(row) : null
    if (!row.runId || !pile) continue
    const list = out.get(row.runId)
    if (list) list.push({ row, pile })
    else out.set(row.runId, [{ row, pile }])
  }
  return out
}

function toRun(r: RunRow, items: Item[]): SortRun {
  const n = (p: SortRunPile): number => items.filter((i) => i.pile === p).length
  return {
    id: r.id,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? null,
    period: isSortPeriod(r.period) ? r.period : 'all',
    trigger: r.trigger === 'nightly' ? 'nightly' : 'manual',
    counts: { sorted: Number(r.sorted), kept: Number(r.keep), thrownAway: Number(r.throwaway), unsure: Number(r.doubtful) },
    now: { kept: n('kept'), thrownAway: n('throwaway'), unsure: n('unsure') }
  }
}

/** The kept runs, newest first. */
export function listRuns(wellRoot: string): SortRun[] {
  const rows = readRunRows(wellRoot)
  if (!rows.length) return []
  const items = itemsByRun(wellRoot)
  return rows.map((r) => toRun(r, items.get(r.id) ?? []))
}

export type SortRunsDeps = {
  wellRoot: () => string
  /** Fallback root for triage rows that carry no source (older scans). */
  sourceRoot: () => string | null
  thumbUrl: (abs: string | null) => string | null
}

/** The runs and their piles for the renderer. Cards and paging as the review piles have them (review/service.ts). */
export class SortRuns {
  constructor(private deps: SortRunsDeps) {}

  list(): SortRun[] {
    return listRuns(this.deps.wellRoot())
  }

  private card(i: Item): SortRunCard {
    const f = i.row.file
    let abs: string | null = null
    if (f && !f.offline) abs = f.kind === 'video' ? (f.posterRel ? join(this.deps.wellRoot(), f.posterRel) : null) : join(f.source || this.deps.sourceRoot() || '', f.relPath)
    const state = i.row.decision?.state
    return {
      hash: i.row.hash,
      filename: f?.filename ?? i.row.hash,
      app: f?.app || null,
      windowTitle: f?.windowTitle || null,
      takenAt: f?.takenAt || null,
      reason: i.row.reason,
      confidence: i.row.confidence,
      lowConfidence: isLowConfidence(i.row.proposal, i.row.confidence),
      proposal: i.row.proposal,
      pile: i.pile,
      decidedBy: i.row.decidedBy,
      decision: state === 'selected' || state === 'included' || state === 'excluded' ? state : null,
      thumbUrl: abs ? this.deps.thumbUrl(abs) : null,
      offline: Boolean(f?.offline)
    }
  }

  // newest first, then by hash (review/piles.ts keyset paging)
  private key = (i: Item): PileKey => pileKey('kept', null, timeOf(i.row), i.row.hash)

  /** One run (null when it is not among the kept runs) and what it still holds. */
  private read(runId: string): { run: SortRun | null; items: Item[] } {
    const row = readRunRows(this.deps.wellRoot()).find((r) => r.id === runId)
    if (!row) return { run: null, items: [] }
    const items = itemsByRun(this.deps.wellRoot()).get(runId) ?? []
    return { run: toRun(row, items), items }
  }

  private pageOf(items: Item[], pile: SortRunPile, after: string | null, limit?: number): SortRunPage {
    const pg = keysetPage(items.filter((i) => i.pile === pile), this.key, after, pageSize(limit))
    return { total: pg.total, items: pg.items.map((i) => this.card(i)), next: pg.next }
  }

  /** The run with the first page of each pile, totals and cursors. More pages: page(). */
  piles(runId: string, opts: { kept?: number; throwaway?: number; unsure?: number } = {}): SortRunPiles {
    const { run, items } = this.read(runId)
    return { run, kept: this.pageOf(items, 'kept', null, opts.kept), throwaway: this.pageOf(items, 'throwaway', null, opts.throwaway), unsure: this.pageOf(items, 'unsure', null, opts.unsure) }
  }

  /** The page after `after` (a cursor from piles() or an earlier page). */
  page(runId: string, pile: SortRunPile, after: string | null, limit?: number): SortRunPage {
    return this.pageOf(this.read(runId).items, pile, after, limit)
  }
}

/** Page size: default 60, at most 500 per request (more by paging). */
function pageSize(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 500) : 60
}
