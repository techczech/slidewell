import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SorterStore, type ProposalRow } from '../src/main/sorter/store'
import { isLowConfidence, listRuns, RUNS_KEPT, SortRuns } from '../src/main/sorter/runs'
import { readReviewRows } from '../src/main/review/store'
import { ReviewService } from '../src/main/review/service'
import { listTriage, setTriageDecision } from '../src/main/triage'

let well: string
let src: string

const FTS = `CREATE VIRTUAL TABLE triage_fts USING fts5(hash UNINDEXED, kind UNINDEXED, rel_path UNINDEXED, filename, ext UNINDEXED, size UNINDEXED, mtime UNINDEXED,
  poster_rel UNINDEXED, offline UNINDEXED, ocr_text, scanned_at UNINDEXED, source UNINDEXED, taken_at UNINDEXED, app, window_title);
  CREATE TABLE triage_decisions (hash TEXT PRIMARY KEY, state TEXT NOT NULL, decided_at TEXT, well_id TEXT);`

function addShots(hashes: string[], app = 'Brightloom'): void {
  const t = new DatabaseSync(join(well, 'triage.db'))
  const row = t.prepare("INSERT INTO triage_fts (hash, kind, rel_path, filename, ext, size, mtime, poster_rel, offline, ocr_text, scanned_at, source, taken_at, app, window_title) VALUES (?, 'image', ?, ?, 'png', '64', ?, '', '0', '', '2026-10-13', ?, ?, ?, 'Canvas')")
  hashes.forEach((h, i) => {
    writeFileSync(join(src, `${h}.png`), Buffer.alloc(64, 1))
    row.run(h, `${h}.png`, `${h}.png`, String(1_760_000_000_000 + i), src, `2026-10-13T10:${String(i % 60).padStart(2, '0')}:00`, app)
  })
  t.close()
}

const p = (hash: string, proposal: ProposalRow['proposal'], confidence = 0.95, extra: Partial<ProposalRow> = {}): ProposalRow => ({ hash, proposal, confidence, pKeep: proposal === 'throwaway' ? 1 - confidence : confidence, reason: `reason for ${hash}`, rule: null, decidedBy: proposal === 'doubtful' ? null : 'history', ...extra })
const run = (n: number, trigger: 'manual' | 'nightly' = 'manual'): { id: string; startedAt: string; period: 'all'; trigger: 'manual' | 'nightly' } => ({ id: `run-${String(n).padStart(3, '0')}`, startedAt: new Date(Date.parse('2026-10-01T00:00:00Z') + n * 3_600_000).toISOString(), period: 'all', trigger })
const runOf = (hash: string): string | null => {
  const db = new DatabaseSync(join(well, 'triage.db'), { readOnly: true })
  try {
    return (db.prepare('SELECT run_id FROM sorter_proposals WHERE hash = ?').get(hash) as { run_id: string | null }).run_id
  } finally {
    db.close()
  }
}
const store = <T>(fn: (s: SorterStore) => T): T => {
  const s = new SorterStore(well)
  try {
    return fn(s)
  } finally {
    s.close()
  }
}
const runs = (): SortRuns => new SortRuns({ wellRoot: () => well, sourceRoot: () => src, thumbUrl: (abs) => (abs ? `thumb://${abs}` : null) })

beforeEach(() => {
  well = mkdtempSync(join(tmpdir(), 'sw-sort-runs-'))
  src = join(well, 'source')
  mkdirSync(src)
  const t = new DatabaseSync(join(well, 'triage.db'))
  t.exec(FTS)
  t.close()
})
afterEach(() => rmSync(well, { recursive: true, force: true }))

describe('sort runs: the record', () => {
  it('a proposal carries the id of the run that last proposed it; a re-proposal moves it to the new run', () => {
    addShots(['a', 'b', 'c'])
    store((s) => {
      s.startRun(run(1))
      s.writeProposals([p('a', 'keep'), p('b', 'throwaway'), p('c', 'doubtful', 0.6)], 'v', null, 'run-001')
      s.finishRun('run-001', { finishedAt: '2026-10-01T01:05:00.000Z', counts: { sorted: 3, keep: 1, throwaway: 1, doubtful: 1 } })
    })
    expect(['a', 'b', 'c'].map(runOf)).toEqual(['run-001', 'run-001', 'run-001'])
    store((s) => {
      s.startRun(run(2, 'nightly'))
      s.writeProposals([p('a', 'throwaway')], 'v', null, 'run-002')
      s.finishRun('run-002', { finishedAt: '2026-10-01T02:05:00.000Z', counts: { sorted: 1, keep: 0, throwaway: 1, doubtful: 0 } })
    })
    expect(['a', 'b', 'c'].map(runOf)).toEqual(['run-002', 'run-001', 'run-001'])
    expect(listRuns(well)).toEqual([
      { id: 'run-002', startedAt: run(2).startedAt, finishedAt: '2026-10-01T02:05:00.000Z', period: 'all', trigger: 'nightly', counts: { sorted: 1, kept: 0, thrownAway: 1, unsure: 0 }, now: { kept: 0, thrownAway: 1, unsure: 0 } },
      { id: 'run-001', startedAt: run(1).startedAt, finishedAt: '2026-10-01T01:05:00.000Z', period: 'all', trigger: 'manual', counts: { sorted: 3, kept: 1, thrownAway: 1, unsure: 1 }, now: { kept: 0, thrownAway: 1, unsure: 1 } }
    ])
  })

  it('a cloud answer that settles a screenshot updates the row in place, in the same run', () => {
    addShots(['a', 'b'])
    store((s) => {
      s.startRun(run(1))
      s.writeProposals([p('a', 'doubtful', 0.6), p('b', 'doubtful', 0.55)], 'v', null, 'run-001')
      s.finishRun('run-001', { finishedAt: '2026-10-01T01:05:00.000Z', counts: { sorted: 2, keep: 0, throwaway: 0, doubtful: 2 } })
      const changed = s.saveCloudResults(
        [{ hash: 'a', provider: 'anthropic', verdict: 'keep', confidence: 0.9, reason: 'a diagram', model: 'm', promptVersion: 'pv', askedAt: '2026-10-01T03:00:00.000Z' }],
        [{ hash: 'a', proposal: 'keep', confidence: 0.9, pKeep: 0.9, reason: 'A diagram', decidedBy: 'haiku', decidedModel: 'm' }]
      )
      expect(changed).toEqual(['a'])
    })
    expect(runOf('a')).toBe('run-001')
    const piles = runs().piles('run-001')
    expect(piles.kept.items.map((c) => [c.hash, c.decidedBy, c.reason])).toEqual([['a', 'haiku', 'A diagram']])
    expect(piles.unsure.items.map((c) => c.hash)).toEqual(['b'])
    expect(piles.run).toMatchObject({ counts: { sorted: 2, kept: 0, thrownAway: 0, unsure: 2 }, now: { kept: 1, thrownAway: 0, unsure: 1 } })
  })

  it(`keeps the newest ${RUNS_KEPT} runs; an older run's id stays on its rows, which still show in Review`, () => {
    addShots(['old', 'new'])
    store((s) => {
      for (let n = 1; n <= RUNS_KEPT + 2; n++) {
        s.startRun(run(n))
        if (n === 1) s.writeProposals([p('old', 'keep')], 'v', null, 'run-001')
        if (n === RUNS_KEPT + 2) s.writeProposals([p('new', 'keep')], 'v', null, run(n).id)
        s.finishRun(run(n).id, { finishedAt: run(n).startedAt, counts: { sorted: n === 1 || n === RUNS_KEPT + 2 ? 1 : 0, keep: 0, throwaway: 0, doubtful: 0 } })
      }
    })
    const list = listRuns(well)
    expect(list).toHaveLength(RUNS_KEPT)
    expect(list[0].id).toBe(run(RUNS_KEPT + 2).id)
    expect(list[list.length - 1].id).toBe('run-003')
    expect(runOf('old')).toBe('run-001')
    expect(readReviewRows(well).map((r) => r.hash).sort()).toEqual(['new', 'old'])
    expect(runs().piles('run-001')).toMatchObject({ run: null, kept: { total: 0, items: [] } })
  })

  it(`runs that never finished are capped too: starting a run drops all but the newest ${RUNS_KEPT}`, () => {
    const count = (): number => {
      const d = new DatabaseSync(join(well, 'triage.db'), { readOnly: true })
      try {
        return Number((d.prepare('SELECT COUNT(*) AS n FROM sorter_runs').get() as { n: number }).n)
      } finally {
        d.close()
      }
    }
    // the app was quit before each sort ended: no finishRun
    store((s) => {
      for (let n = 1; n <= RUNS_KEPT + 1; n++) s.startRun(run(n))
    })
    expect(count()).toBe(RUNS_KEPT)
    expect(listRuns(well).map((r) => r.id)).not.toContain('run-001')
    // a run started with a clock behind the others is still recorded, and the cap holds
    store((s) => s.startRun({ ...run(0), id: 'run-behind' }))
    expect(count()).toBe(RUNS_KEPT)
    expect(listRuns(well).map((r) => r.id)).toContain('run-behind')
    // a start that fails leaves the table as it was
    expect(() => store((s) => s.startRun({ ...run(99), id: 'run-behind' }))).toThrow()
    expect(count()).toBe(RUNS_KEPT)
  })

  it('a database from before runs: the column is added, old proposals have no run and still show in Review and in Triage', async () => {
    const t = new DatabaseSync(join(well, 'triage.db'))
    t.exec(`CREATE TABLE sorter_proposals (hash TEXT PRIMARY KEY, proposal TEXT NOT NULL CHECK (proposal IN ('keep', 'throwaway', 'doubtful')), confidence REAL NOT NULL, p_keep REAL NOT NULL, reason TEXT NOT NULL, rule TEXT,
      sorter_version TEXT NOT NULL, model_id TEXT, proposed_at TEXT NOT NULL, throwaway_since TEXT, answered_at TEXT, answer TEXT, decided_by TEXT, decided_model TEXT);
      INSERT INTO sorter_proposals (hash, proposal, confidence, p_keep, reason, sorter_version, proposed_at) VALUES ('a', 'keep', 0.9, 0.9, 'from before', 'v', '2026-10-01T00:00:00Z');`)
    t.close()
    addShots(['a', 'b'])
    // read before any migration ran: Review still lists it
    expect(readReviewRows(well).map((r) => [r.hash, r.runId])).toEqual([['a', null]])
    expect(listRuns(well)).toEqual([])
    store(() => undefined)
    expect(runOf('a')).toBeNull()
    expect(readReviewRows(well).map((r) => [r.hash, r.runId])).toEqual([['a', null]])
    const review = new ReviewService({ wellRoot: () => well, archiveRoot: () => well, sourceRoot: () => src, thumbUrl: () => null })
    expect((await review.piles()).kept.items.map((c) => c.hash)).toEqual(['a'])
    expect((await listTriage(well, '', 'undecided')).map((r) => [r.hash, r.proposal ?? null]).sort()).toEqual([['a', 'keep'], ['b', null]])
    store((s) => {
      s.startRun(run(1))
      s.writeProposals([p('b', 'keep')], 'v', null, 'run-001')
    })
    expect(runOf('b')).toBe('run-001')
    expect(runOf('a')).toBeNull()
    expect(listRuns(well)).toMatchObject([{ id: 'run-001', finishedAt: null, counts: { sorted: 0 }, now: { kept: 1 } }])
  })
})

describe('sort runs: the piles of one run', () => {
  const hashes = Array.from({ length: 7 }, (_, i) => `k${i}`)
  beforeEach(() => {
    addShots([...hashes, 't0', 't1', 'u0'])
    addShots(['other'], '')
    store((s) => {
      s.startRun(run(1))
      s.writeProposals([p('other', 'keep')], 'v', null, 'run-001')
      s.startRun(run(2))
      s.writeProposals(
        [...hashes.map((h) => p(h, 'keep', 0.95, { decidedBy: 'rules' })), p('t0', 'throwaway', 0.97, { decidedBy: 'luna' }), p('t1', 'throwaway', 0.91), p('u0', 'doubtful', 0.55)],
        'v',
        null,
        'run-002'
      )
      s.finishRun('run-002', { finishedAt: '2026-10-01T02:05:00.000Z', counts: { sorted: 10, keep: 7, throwaway: 2, doubtful: 1 } })
    })
  })

  it('three piles, each card with what Review cards carry plus who decided and the low-confidence flag', () => {
    const piles = runs().piles('run-002')
    expect([piles.kept.total, piles.throwaway.total, piles.unsure.total]).toEqual([7, 2, 1])
    const t0 = piles.throwaway.items.find((c) => c.hash === 't0')!
    expect(t0).toEqual({ hash: 't0', filename: 't0.png', app: 'Brightloom', windowTitle: 'Canvas', takenAt: '2026-10-13T10:07:00', reason: 'reason for t0', confidence: 0.97, lowConfidence: false, proposal: 'throwaway', pile: 'throwaway', decidedBy: 'luna', decision: null, thumbUrl: `thumb://${join(src, 't0.png')}`, offline: false })
    expect(piles.throwaway.items.find((c) => c.hash === 't1')!.lowConfidence).toBe(true)
    expect(piles.unsure.items[0]).toMatchObject({ hash: 'u0', proposal: 'doubtful', pile: 'unsure', decidedBy: null, lowConfidence: true })
    expect(piles.kept.items.some((c) => c.hash === 'other')).toBe(false) // another run's
  })

  it('pages each pile by cursor: nothing repeated, nothing skipped', () => {
    const first = runs().piles('run-002', { kept: 3 })
    expect(first.kept.items).toHaveLength(3)
    expect(first.kept.next).not.toBeNull()
    const second = runs().page('run-002', 'kept', first.kept.next, 3)
    const third = runs().page('run-002', 'kept', second.next, 3)
    expect(third.next).toBeNull()
    expect([...first.kept.items, ...second.items, ...third.items].map((c) => c.hash).sort()).toEqual(hashes)
    expect(second.total).toBe(7)
    expect(runs().page('run-002', 'unsure', null).items.map((c) => c.hash)).toEqual(['u0'])
    expect(runs().page('no-such-run', 'kept', null)).toEqual({ total: 0, items: [], next: null })
  })

  it('moving one across is his decision through the Triage path: the card shows it, the counts follow, undecided again puts it back', async () => {
    await setTriageDecision(well, well, src, 't0', 'select')
    await setTriageDecision(well, well, src, 'k0', 'exclude')
    let piles = runs().piles('run-002')
    expect([piles.kept.total, piles.throwaway.total, piles.unsure.total]).toEqual([7, 2, 1])
    expect(piles.kept.items.find((c) => c.hash === 't0')).toMatchObject({ pile: 'kept', proposal: 'throwaway', decision: 'selected' })
    expect(piles.throwaway.items.find((c) => c.hash === 'k0')).toMatchObject({ pile: 'throwaway', proposal: 'keep', decision: 'excluded' })
    await setTriageDecision(well, well, src, 'u0', 'exclude')
    piles = runs().piles('run-002')
    expect(piles.run!.now).toEqual({ kept: 7, thrownAway: 3, unsure: 0 })
    expect(piles.run!.counts).toEqual({ sorted: 10, kept: 7, thrownAway: 2, unsure: 1 }) // as the sort ended
    await setTriageDecision(well, well, src, 't0', 'reset')
    expect(runs().piles('run-002').throwaway.items.find((c) => c.hash === 't0')).toMatchObject({ pile: 'throwaway', decision: null })
    expect(runOf('t0')).toBe('run-002')
  })

  it('an emptied item is in no pile', () => {
    const t = new DatabaseSync(join(well, 'triage.db'))
    t.exec("INSERT INTO triage_decisions (hash, state, decided_at) VALUES ('t1', 'emptied', '2026-10-02')")
    t.close()
    const piles = runs().piles('run-002')
    expect(piles.throwaway.items.map((c) => c.hash)).toEqual(['t0'])
    expect(piles.run!.now.thrownAway).toBe(1)
  })
})

describe('sort runs: low confidence', () => {
  it('a keep or throwaway just over its threshold, and an unsure one close to even', () => {
    expect(isLowConfidence('keep', 0.75)).toBe(true)
    expect(isLowConfidence('keep', 0.8)).toBe(false)
    expect(isLowConfidence('throwaway', 0.92)).toBe(true)
    expect(isLowConfidence('throwaway', 0.95)).toBe(false)
    expect(isLowConfidence('doubtful', 0.55)).toBe(true)
    expect(isLowConfidence('doubtful', 0.68)).toBe(false)
  })
})
