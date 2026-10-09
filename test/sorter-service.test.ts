import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))
const { SorterService } = await import('../src/main/sorter/service')
const { runJob } = await import('../src/main/sorter/jobs')
const { SorterStore } = await import('../src/main/sorter/store')
const { SORTER_VERSION } = await import('../src/main/sorter/decide')
type Deps = ConstructorParameters<typeof SorterService>[0]

// A well with `kept` included and `binned` excluded triage screenshots plus 3 undecided ones; each has
// its own picture file, and the fake picture engine gives each a distinct synthetic embedding.
function makeWell(kept: number, binned: number): string {
  const well = mkdtempSync(join(tmpdir(), 'sw-sorter-svc-'))
  const src = join(well, 'source')
  mkdirSync(src, { recursive: true })
  const t = new DatabaseSync(join(well, 'triage.db'))
  t.exec(`CREATE VIRTUAL TABLE triage_fts USING fts5(hash UNINDEXED, kind UNINDEXED, rel_path UNINDEXED, filename, ext UNINDEXED, size UNINDEXED, mtime UNINDEXED,
            poster_rel UNINDEXED, offline UNINDEXED, ocr_text, scanned_at UNINDEXED, source UNINDEXED, taken_at UNINDEXED, app, window_title);
          CREATE TABLE triage_decisions (hash TEXT PRIMARY KEY, state TEXT NOT NULL, decided_at TEXT, well_id TEXT);`)
  const row = t.prepare("INSERT INTO triage_fts (hash, kind, rel_path, filename, ext, offline, ocr_text, source, taken_at, app, window_title) VALUES (?, 'image', ?, ?, 'png', '0', '', ?, '', '', '')")
  const dec = t.prepare('INSERT INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, ?, ?, NULL)')
  const add = (hash: string, state: string | null): void => {
    writeFileSync(join(src, `${hash}.png`), Buffer.alloc(64, hash.length))
    row.run(hash, `${hash}.png`, `${hash}.png`, src)
    if (state) dec.run(hash, state, '2026-10-01')
  }
  for (let i = 0; i < kept; i++) add(`keep${i}`, 'included')
  for (let i = 0; i < binned; i++) add(`bin${i}`, 'excluded')
  for (let i = 0; i < 3; i++) add(`new${i}`, null)
  t.close()
  return well
}

function vectorFor(id: string): Float32Array {
  // a shared direction, a keep or bin direction, and per-id noise (pairwise cosines well below 0.95)
  let s = 0
  for (const c of id) s = (Math.imul(s, 31) + c.charCodeAt(0)) >>> 0
  const v = new Float32Array(48)
  v[0] = 1
  v[id.includes('keep') ? 1 : 2] = id.includes('new') ? 0 : 0.8
  for (let i = 3; i < 48; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    v[i] = (s / 2 ** 32 - 0.5) * 0.9
  }
  const n = Math.hypot(...v)
  return v.map((x) => x / n)
}

function deps(well: string, extra: Partial<Deps> = {}): Deps {
  return {
    wellRoot: () => well,
    pictures: {
      modelReady: () => true,
      ensureVectors: async (items) => new Map(items.map((it) => [it.id, vectorFor(it.id)]))
    },
    broadcast: () => undefined,
    ...extra
  }
}

const models = (well: string): number => {
  const db = new DatabaseSync(join(well, 'triage.db'), { readOnly: true })
  try {
    return Number((db.prepare('SELECT COUNT(*) AS n FROM sorter_models').get() as { n: number }).n)
  } finally {
    db.close()
  }
}

let wells: string[] = []
beforeEach(() => {
  wells = []
})
afterEach(() => {
  for (const w of wells) rmSync(w, { recursive: true, force: true })
})
const well = (k: number, b: number): string => {
  const w = makeWell(k, b)
  wells.push(w)
  return w
}

describe('sorter service: unattended sorting needs enough held-back evidence', () => {
  it('a small history trains and reports, but sorting stays refused', async () => {
    const w = well(24, 12) // held back: 5 kept + 3 binned; training keeps 19 + 9, enough to calibrate
    const svc = new SorterService(deps(w))
    const r = await svc.trainAndTest()
    expect(r.ok).toBe(true)
    expect(r.report!.enoughToMeasure).toBe(false)
    expect(svc.status().canRunUnattended).toBe(false)
    const s = await svc.sortUndecided()
    expect(s.ok).toBe(false)
    expect(s.error).toBe('not enough of your past choices to measure accuracy yet')
  })

  it('a big enough history allows sorting, which records proposals for undecided screenshots only', async () => {
    const w = well(60, 30) // held back: 12 kept + 6 binned = 18, below 20
    const w2 = well(70, 30) // held back: 14 kept + 6 binned = 20
    const small = new SorterService(deps(w))
    expect((await small.trainAndTest()).report!.heldBack.sample).toBe(18)
    expect(small.status().canRunUnattended).toBe(false)
    const svc = new SorterService(deps(w2))
    const r = await svc.trainAndTest()
    expect(r.report!.heldBack.sample).toBe(20)
    expect(r.report!.grouping).toMatchObject({ groups: 100, largest: 1 }) // labelled only; no near-copies here
    expect(svc.status().canRunUnattended).toBe(true)
    const s = await svc.sortUndecided()
    expect(s).toMatchObject({ ok: true, sorted: 3 })
  })
})

describe('sorter service: Stop during training', () => {
  // a job runner that runs `kind` jobs until told to stop (as the worker does) and runs the rest
  function hanging(kind: 'group' | 'train') {
    const seen: string[] = []
    let started: () => void = () => undefined
    const running = new Promise<void>((r) => (started = r))
    const run: Deps['runJob'] = (job, signal) => {
      seen.push(job.kind)
      if (job.kind !== kind) return Promise.resolve(runJob(job))
      started()
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled'))))
    }
    return { run, running, seen }
  }

  for (const kind of ['group', 'train'] as const) {
    it(`stopping during ${kind === 'group' ? 'grouping' : 'a fit'} returns cancelled, runs nothing further and saves nothing`, async () => {
      const w = well(70, 30)
      const h = hanging(kind)
      const svc = new SorterService(deps(w, { runJob: h.run }))
      const run = svc.trainAndTest()
      await h.running
      svc.cancel()
      expect(await run).toMatchObject({ ok: false, cancelled: true })
      expect(h.seen).toEqual(kind === 'group' ? ['group'] : ['group', 'train'])
      expect(models(w)).toBe(0)
      expect(svc.status().phase).toBe('idle')
    })
  }

  it('stopping just as a fit finishes still saves nothing', async () => {
    const w = well(70, 30)
    let svc: InstanceType<typeof SorterService> | null = null
    svc = new SorterService(
      deps(w, {
        runJob: async (job) => {
          const r = runJob(job)
          if (job.kind === 'train') svc!.cancel() // Stop pressed while this fit was finishing: its result must not be used
          return r
        }
      })
    )
    const r = await svc.trainAndTest()
    expect(r).toMatchObject({ ok: false, cancelled: true })
    expect(models(w)).toBe(0)
  })
})

describe('sorter service: only a model made under the current version sorts', () => {
  it('an older model shows "retrain needed" and sorting is refused; retraining clears it', async () => {
    const w = well(70, 30)
    const svc = new SorterService(deps(w))
    const fresh = await svc.trainAndTest()
    expect(fresh.ok).toBe(true)
    // the same model and report, but stamped with an earlier sorter version
    const st = new SorterStore(w)
    const rec = st.latestModel<Record<string, unknown>>()!
    st.saveModel({ ...rec, id: 'old', trainedAt: '2099-01-01T00:00:00Z', sorterVersion: 'sorter-local-1', report: { ...rec.report, sorterVersion: 'sorter-local-1' } })
    st.close()
    expect(svc.status()).toMatchObject({ retrainNeeded: true, canRunUnattended: false, report: null })
    const s = await svc.sortUndecided()
    expect(s.ok).toBe(false)
    expect(s.error).toMatch(/^retrain needed/)
    // a report stamped current on a model stamped old (or the reverse) does not count either
    const st2 = new SorterStore(w)
    st2.saveModel({ ...rec, id: 'mixed', trainedAt: '2099-02-01T00:00:00Z', sorterVersion: 'sorter-local-1', report: { ...rec.report, sorterVersion: SORTER_VERSION } })
    st2.close()
    expect(svc.status().retrainNeeded).toBe(true)
  })
})

describe('sorter service: too few independent examples', () => {
  it('training fails plainly and saves nothing', async () => {
    const w = well(8, 4)
    const svc = new SorterService(deps(w))
    const r = await svc.trainAndTest()
    expect(r).toMatchObject({ ok: false, error: 'not enough independent examples to calibrate' })
    expect(models(w)).toBe(0)
  })
})

describe('sorter service: the cascade on re-sort (ticket 07)', () => {
  it('records which step decided, re-applies a Luna answer in the same write, and keeps a throwaway clock', async () => {
    const w = well(70, 30)
    // everything doubtful locally: keep needs 0.999, throwaway 0.999
    const svc = new SorterService(deps(w, { thresholds: { throwaway: 0.999, keep: 0.999 } }))
    expect((await svc.trainAndTest()).ok).toBe(true)
    expect(await svc.sortUndecided()).toMatchObject({ ok: true, counts: { doubtful: 3 } })
    const st = new SorterStore(w)
    st.saveCloudResults(
      [
        { hash: 'new0', verdict: 'keep', confidence: 0.9, reason: 'A chart worth keeping.', model: 'gpt-6-luna', promptVersion: 'luna-prompt-1', askedAt: '2026-10-09T02:00:00Z' },
        { hash: 'new1', verdict: 'throwaway', confidence: 0.9995, reason: 'A settings pane.', model: 'gpt-6-luna', promptVersion: 'luna-prompt-1', askedAt: '2026-10-09T02:00:00Z' },
        { hash: 'new2', verdict: 'throwaway', confidence: 0.99, reason: 'A file picker.', model: 'an-older-model', promptVersion: 'luna-prompt-1', askedAt: '2026-10-09T02:00:00Z' }
      ],
      []
    )
    st.close()
    const row = (h: string) => {
      const db = new DatabaseSync(join(w, 'triage.db'), { readOnly: true })
      try {
        return db.prepare('SELECT proposal, decided_by, throwaway_since FROM sorter_proposals WHERE hash = ?').get(h) as { proposal: string; decided_by: string | null; throwaway_since: string | null }
      } finally {
        db.close()
      }
    }
    await svc.sortUndecided()
    expect(row('new0')).toMatchObject({ proposal: 'keep', decided_by: 'luna' })
    expect(row('new1')).toMatchObject({ proposal: 'throwaway', decided_by: 'luna' })
    expect(row('new2')).toMatchObject({ proposal: 'doubtful', decided_by: null }) // an answer from another model does not count
    const since = row('new1').throwaway_since
    expect(since).not.toBeNull()
    await new Promise((r) => setTimeout(r, 5))
    await svc.sortUndecided()
    expect(row('new1').throwaway_since).toBe(since) // the 30-day clock is not restarted by a re-sort

    // with ordinary thresholds the local steps make confident calls and say which step made them
    const plain = new SorterService(deps(w))
    await plain.sortUndecided()
    for (const h of ['new0', 'new1', 'new2']) {
      const r = row(h)
      if (r.proposal === 'doubtful') expect(r.decided_by === null || r.decided_by === 'luna').toBe(true)
      else expect(['rules', 'history', 'luna']).toContain(r.decided_by)
    }
  })
})
