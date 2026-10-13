/**
 * A scratch well for the teach-the-sorter tests (ticket 22): triage.db with decided and undecided
 * screenshots, each with its own (dummy) picture file, and a fake picture engine that gives every
 * picture a synthetic embedding from its name. Invented names only; nothing outside the temp folder
 * is read.
 *
 * Names decide the embedding: one containing "keep" points the kept way, one containing "toss" the
 * thrown-away way, anything else neither (the sorter will not be sure of it).
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export type FixtureShot = { hash: string; state?: 'included' | 'excluded' | 'selected' | null; app?: string; decidedAt?: string; takenAt?: string }

export const DIM = 48

export function vectorFor(id: string): Float32Array {
  let s = 0
  for (const c of id) s = (Math.imul(s, 31) + c.charCodeAt(0)) >>> 0
  const v = new Float32Array(DIM)
  v[0] = 1
  if (id.includes('keep')) v[1] = 0.8
  else if (id.includes('toss')) v[2] = 0.8
  for (let i = 3; i < DIM; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    v[i] = (s / 2 ** 32 - 0.5) * 0.9
  }
  const n = Math.hypot(...v)
  return v.map((x) => x / n)
}

/** The picture engine's two seams, backed by vectorFor. `calls` counts pictures asked for through ensureVectors. */
export function fakePictures(): { modelReady: () => boolean; ensureVectors: (items: Array<{ id: string }>) => Promise<Map<string, Float32Array>>; stored: (ids: string[]) => Map<string, Float32Array>; calls: { n: number } } {
  const calls = { n: 0 }
  return {
    modelReady: () => true,
    ensureVectors: async (items) => {
      calls.n += items.length
      return new Map(items.map((it) => [it.id, vectorFor(it.id)]))
    },
    stored: (ids) => new Map(ids.map((id) => [id, vectorFor(id)])),
    calls
  }
}

export function openTriage(well: string): DatabaseSync {
  return new DatabaseSync(join(well, 'triage.db'))
}

/** Add screenshots to a well made by teachWell (or decide ones already there: the decision row is replaced). */
export function addShots(well: string, shots: FixtureShot[]): void {
  const src = join(well, 'source')
  const t = openTriage(well)
  try {
    const have = t.prepare('SELECT 1 FROM triage_fts WHERE hash = ?')
    const row = t.prepare("INSERT INTO triage_fts (hash, kind, rel_path, filename, ext, offline, ocr_text, source, taken_at, app, window_title) VALUES (?, 'image', ?, ?, 'png', '0', '', ?, ?, ?, '')")
    const dec = t.prepare('INSERT OR REPLACE INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, ?, ?, NULL)')
    for (const s of shots) {
      if (!have.get(s.hash)) {
        writeFileSync(join(src, `${s.hash}.png`), Buffer.alloc(64, s.hash.length))
        row.run(s.hash, `${s.hash}.png`, `${s.hash}.png`, src, s.takenAt ?? '', s.app ?? '')
      }
      if (s.state) dec.run(s.hash, s.state, s.decidedAt ?? '2026-10-01T09:00:00.000Z')
    }
  } finally {
    t.close()
  }
}

/** A well with `kept` included ("keep<i>") and `thrown` excluded ("toss<i>") screenshots, plus `more`. */
export function teachWell(kept: number, thrown: number, more: FixtureShot[] = []): string {
  const well = mkdtempSync(join(tmpdir(), 'sw-teach-'))
  mkdirSync(join(well, 'source'), { recursive: true })
  const t = openTriage(well)
  t.exec(`CREATE VIRTUAL TABLE triage_fts USING fts5(hash UNINDEXED, kind UNINDEXED, rel_path UNINDEXED, filename, ext UNINDEXED, size UNINDEXED, mtime UNINDEXED,
            poster_rel UNINDEXED, offline UNINDEXED, ocr_text, scanned_at UNINDEXED, source UNINDEXED, taken_at UNINDEXED, app, window_title);
          CREATE TABLE triage_decisions (hash TEXT PRIMARY KEY, state TEXT NOT NULL, decided_at TEXT, well_id TEXT);`)
  t.close()
  addShots(well, [
    ...Array.from({ length: kept }, (_, i): FixtureShot => ({ hash: `keep${i}`, state: 'included' })),
    ...Array.from({ length: thrown }, (_, i): FixtureShot => ({ hash: `toss${i}`, state: 'excluded' })),
    ...more
  ])
  return well
}

export type ProposalSeed = { hash: string; proposal?: 'keep' | 'throwaway' | 'doubtful'; pKeep?: number; reason?: string; sorterVersion: string; runId?: string | null; proposedAt?: string; answeredAt?: string | null }

/** Write proposals straight into sorter_proposals (the table must exist: open a SorterStore on the well first). */
export function seedProposals(well: string, rows: ProposalSeed[]): void {
  const t = openTriage(well)
  try {
    const put = t.prepare(
      'INSERT OR REPLACE INTO sorter_proposals (hash, proposal, confidence, p_keep, reason, rule, sorter_version, model_id, proposed_at, throwaway_since, answered_at, answer, run_id) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?)'
    )
    for (const r of rows) {
      const p = r.pKeep ?? 0.5
      const proposal = r.proposal ?? 'doubtful'
      const at = r.proposedAt ?? '2026-10-10T08:00:00.000Z'
      put.run(r.hash, proposal, Math.max(p, 1 - p), p, r.reason ?? 'Not sure: no rule fits and there is nothing learnt to compare it with', r.sorterVersion, at, proposal === 'throwaway' ? at : null, r.answeredAt ?? null, r.answeredAt ? 'keep' : null, r.runId ?? null)
    }
  } finally {
    t.close()
  }
}

export function proposalsOf(well: string): Map<string, { proposal: string; p_keep: number; reason: string; run_id: string | null; proposed_at: string; sorter_version: string; model_id: string | null; throwaway_since: string | null }> {
  const t = new DatabaseSync(join(well, 'triage.db'), { readOnly: true })
  try {
    const rows = t.prepare('SELECT hash, proposal, p_keep, reason, run_id, proposed_at, sorter_version, model_id, throwaway_since FROM sorter_proposals').all() as Array<{ hash: string; proposal: string; p_keep: number; reason: string; run_id: string | null; proposed_at: string; sorter_version: string; model_id: string | null; throwaway_since: string | null }>
    return new Map(rows.map((r) => [r.hash, r]))
  } finally {
    t.close()
  }
}

export function countRows(well: string, table: string): number {
  const t = new DatabaseSync(join(well, 'triage.db'), { readOnly: true })
  try {
    return Number((t.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
  } finally {
    t.close()
  }
}
