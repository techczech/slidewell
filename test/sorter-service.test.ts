import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))
const { SorterService, cloudGates } = await import('../src/main/sorter/service')
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

const runCount = (well: string): number => {
  const db = new DatabaseSync(join(well, 'triage.db'), { readOnly: true })
  try {
    return Number((db.prepare('SELECT COUNT(*) AS n FROM sorter_runs').get() as { n: number }).n)
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
        { hash: 'new0', verdict: 'keep', confidence: 0.9, reason: 'A chart worth keeping.', provider: 'openai', model: 'gpt-6-luna', promptVersion: 'luna-prompt-1', askedAt: '2026-10-09T02:00:00Z' },
        { hash: 'new1', verdict: 'throwaway', confidence: 0.9995, reason: 'A settings pane.', provider: 'openai', model: 'gpt-6-luna', promptVersion: 'luna-prompt-1', askedAt: '2026-10-09T02:00:00Z' },
        { hash: 'new2', verdict: 'throwaway', confidence: 0.99, reason: 'A file picker.', provider: 'openai', model: 'an-older-model', promptVersion: 'luna-prompt-1', askedAt: '2026-10-09T02:00:00Z' }
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

  it('re-applies a Haiku answer the same way, under Haiku’s name and model (ticket 16)', async () => {
    const w = well(70, 30)
    const svc = new SorterService(deps(w, { thresholds: { throwaway: 0.999, keep: 0.999 } }))
    expect((await svc.trainAndTest()).ok).toBe(true)
    expect(await svc.sortUndecided()).toMatchObject({ ok: true, counts: { doubtful: 3 } })
    const st = new SorterStore(w)
    st.saveCloudResults(
      [
        { hash: 'new0', verdict: 'keep', confidence: 0.9, reason: 'A chart worth keeping.', provider: 'anthropic', model: 'claude-haiku-5-5', promptVersion: 'haiku-prompt-1', askedAt: '2026-10-11T02:00:00Z' },
        { hash: 'new1', verdict: 'unsure', confidence: 0.5, reason: 'Hard to tell.', provider: 'anthropic', model: 'claude-haiku-5-5', promptVersion: 'haiku-prompt-1', askedAt: '2026-10-11T02:00:00Z' },
        // Haiku's model under Luna's prompt version is not an answer either provider gave
        { hash: 'new2', verdict: 'keep', confidence: 0.9, reason: 'A chart.', provider: 'anthropic', model: 'claude-haiku-5-5', promptVersion: 'luna-prompt-1', askedAt: '2026-10-11T02:00:00Z' }
      ],
      []
    )
    st.close()
    await svc.sortUndecided()
    const db = new DatabaseSync(join(w, 'triage.db'), { readOnly: true })
    try {
      const row = (h: string): unknown => db.prepare('SELECT proposal, decided_by, decided_model, reason FROM sorter_proposals WHERE hash = ?').get(h)
      expect(row('new0')).toMatchObject({ proposal: 'keep', decided_by: 'haiku', decided_model: 'claude-haiku-5-5', reason: 'A chart worth keeping' })
      expect(row('new1')).toMatchObject({ proposal: 'doubtful', decided_by: 'haiku', decided_model: 'claude-haiku-5-5', reason: 'Not sure, and Haiku was not sure either: hard to tell' })
      expect(row('new2')).toMatchObject({ proposal: 'doubtful', decided_by: null, decided_model: null })
    } finally {
      db.close()
    }
  })

  it('re-applies the answer that stands when both providers have answered a screenshot (ticket 17)', async () => {
    const w = well(70, 30)
    const svc = new SorterService(deps(w, { thresholds: { throwaway: 0.999, keep: 0.999 } }))
    expect((await svc.trainAndTest()).ok).toBe(true)
    expect(await svc.sortUndecided()).toMatchObject({ ok: true, counts: { doubtful: 3 } })
    const luna = { provider: 'openai' as const, model: 'gpt-6-luna', promptVersion: 'luna-prompt-1', askedAt: '2026-10-10T02:00:00Z' }
    const haiku = { provider: 'anthropic' as const, model: 'claude-haiku-5-5', promptVersion: 'haiku-prompt-1', askedAt: '2026-10-11T02:00:00Z' }
    const st = new SorterStore(w)
    st.saveCloudResults(
      [
        // Luna unsure first, then Haiku's keep: Haiku's decision stands
        { hash: 'new0', verdict: 'unsure', confidence: 0.5, reason: 'Hard to tell.', ...luna },
        { hash: 'new0', verdict: 'keep', confidence: 0.9, reason: 'A chart worth keeping.', ...haiku },
        // both unsure: the one asked last (Haiku) gives the words
        { hash: 'new1', verdict: 'unsure', confidence: 0.5, reason: 'Hard to tell.', ...luna },
        { hash: 'new1', verdict: 'unsure', confidence: 0.4, reason: 'Could be either.', ...haiku },
        // Haiku unsure first, then Luna's sure throwaway a day later: Luna's decision stands
        { hash: 'new2', verdict: 'unsure', confidence: 0.5, reason: 'Hard to tell.', ...haiku, askedAt: '2026-10-09T02:00:00Z' },
        { hash: 'new2', verdict: 'throwaway', confidence: 0.9995, reason: 'A settings pane.', ...luna }
      ],
      []
    )
    st.close()
    await svc.sortUndecided()
    const db = new DatabaseSync(join(w, 'triage.db'), { readOnly: true })
    try {
      const row = (h: string): unknown => db.prepare('SELECT proposal, decided_by, decided_model, reason FROM sorter_proposals WHERE hash = ?').get(h)
      expect(row('new0')).toMatchObject({ proposal: 'keep', decided_by: 'haiku', decided_model: 'claude-haiku-5-5', reason: 'A chart worth keeping' })
      expect(row('new1')).toMatchObject({ proposal: 'doubtful', decided_by: 'haiku', decided_model: 'claude-haiku-5-5', reason: 'Not sure, and Haiku was not sure either: could be either' })
      expect(row('new2')).toMatchObject({ proposal: 'throwaway', decided_by: 'luna', decided_model: 'gpt-6-luna', reason: 'A settings pane' })
      expect(db.prepare('SELECT COUNT(*) AS n FROM sorter_cloud_answers').get()).toEqual({ n: 6 }) // a re-sort leaves both rows of each
    } finally {
      db.close()
    }
  })
})

describe('sorter service: numbers for the Auto sorting tab (ticket 18)', () => {
  const NOW = new Date(2026, 9, 12, 12, 0, 0)
  const date = (w: string, hash: string, takenAt: string): void => {
    const db = new DatabaseSync(join(w, 'triage.db'))
    db.prepare('UPDATE triage_fts SET taken_at = ? WHERE hash = ?').run(takenAt, hash)
    db.close()
  }

  it('counts the undecided screenshots in the chosen period and in all, and his usable choices, only when asked', async () => {
    const w = well(70, 30)
    date(w, 'new0', '2026-10-10T09:00:00') // two days ago
    date(w, 'new1', '2026-09-01T09:00:00') // six weeks ago; new2 has no date
    let period: unknown = '7d'
    const svc = new SorterService(deps(w, { period: () => period, now: () => NOW }))
    expect(svc.status()).toMatchObject({ undecided: null, learnable: null, lastRun: null }) // not counted yet
    expect(svc.status({ count: true })).toMatchObject({ undecided: { period: '7d', inPeriod: 1, all: 3 }, learnable: { kept: 70, binned: 30 } })
    expect(svc.status().undecided).toEqual({ period: '7d', inPeriod: 1, all: 3 }) // a status in between carries the last count
    period = '90d'
    expect(svc.status({ count: true }).undecided).toEqual({ period: '90d', inPeriod: 2, all: 3 })
    period = undefined // never chosen: everything, the undated one included
    expect(svc.status({ count: true }).undecided).toEqual({ period: 'all', inPeriod: 3, all: 3 })
    // a stored period that is not one of the four is not everything: no count for it
    for (const bad of [null, 'bogus', 30]) {
      period = bad
      expect(svc.status({ count: true }).undecided).toEqual({ period: null, inPeriod: null, all: 3 })
    }
    // a choice whose picture is gone is nothing to learn from; one he decides is no longer undecided
    rmSync(join(w, 'source', 'bin0.png'))
    const db = new DatabaseSync(join(w, 'triage.db'))
    db.prepare("INSERT INTO triage_decisions (hash, state, decided_at, well_id) VALUES ('new0', 'included', '2026-10-12', NULL)").run()
    db.close()
    period = '7d'
    expect(svc.status({ count: true })).toMatchObject({ undecided: { period: '7d', inPeriod: 0, all: 2 }, learnable: { kept: 71, binned: 29 } })
  })

  it('the count for the period is the number a manual sort then looks at, and the period change pushes a fresh count', async () => {
    const w = well(70, 30)
    date(w, 'new0', '2026-10-10T09:00:00')
    date(w, 'new1', '2026-10-11T09:00:00')
    let period: unknown = '7d'
    const pushed: Array<ReturnType<InstanceType<typeof SorterService>['status']>> = []
    const svc = new SorterService(deps(w, { period: () => period, now: () => NOW, broadcast: (s) => void pushed.push(s) }))
    expect((await svc.trainAndTest()).ok).toBe(true)
    const counted = svc.status({ count: true }).undecided!.inPeriod
    expect(counted).toBe(2)
    expect(await svc.sortManual()).toMatchObject({ ok: true, sorted: counted, period: '7d' })
    period = 'all'
    svc.notify()
    expect(pushed.at(-1)!.undecided).toEqual({ period: 'all', inPeriod: 3, all: 3 })
  })

  it('records each sort as numbers, kept across a restart; a refused sort records nothing', async () => {
    const w = well(70, 30)
    const box: { run: unknown } = { run: undefined }
    const kept = { lastRun: () => box.run, saveLastRun: (r: unknown) => void (box.run = r), now: () => NOW }
    const svc = new SorterService(deps(w, { ...kept, thresholds: { throwaway: 0.999, keep: 0.999 } }))
    expect((await svc.sortUndecided()).ok).toBe(false) // not trained yet
    expect(box.run).toBeUndefined()
    expect(svc.status().lastRun).toBeNull()
    expect((await svc.trainAndTest()).ok).toBe(true)
    const r = await svc.sortUndecided()
    expect(r).toMatchObject({ ok: true, sorted: 3, counts: { doubtful: 3 } })
    expect(box.run).toEqual({ at: NOW.toISOString(), period: 'all', lookedAt: 3, confident: 0, needLook: 3 })
    expect(svc.status()).toMatchObject({ lastRun: box.run, undecided: { all: 3 } }) // and the counts were taken again
    // a restart: another service over the same stored value
    const again = new SorterService(deps(w, kept))
    expect(again.status().lastRun).toEqual(box.run)
    const plain = await again.sortUndecided()
    expect(box.run).toEqual({ at: NOW.toISOString(), period: 'all', lookedAt: 3, confident: plain.counts!.keep + plain.counts!.throwaway, needLook: plain.counts!.doubtful })
    // what is stored but is not a run is no run
    for (const bad of [null, 'yesterday', {}, { at: 'x', period: 'all', lookedAt: 3, confident: 1, needLook: 2 }, { at: NOW.toISOString(), period: 'week', lookedAt: 3, confident: 1, needLook: 2 }, { at: NOW.toISOString(), period: 'all', lookedAt: '3', confident: 1, needLook: 2 }, { at: NOW.toISOString(), period: 'all', lookedAt: -1, confident: 1, needLook: 2 }]) {
      box.run = bad
      expect(again.status().lastRun).toBeNull()
    }
  })
})

describe('sorter service: the accuracy report is for the app rules it was tested with', () => {
  it('changing a rule keeps Sort now, refuses unattended sorting and says so; training again clears it', async () => {
    const w = well(70, 30)
    let rules: unknown = [{ app: 'Quillpad', rule: 'keep' }, { app: 'Mossgrid', rule: 'throwaway' }]
    const svc = new SorterService(deps(w, { appRules: () => rules }))
    expect((await svc.trainAndTest()).ok).toBe(true)
    expect(svc.status()).toMatchObject({ canRunUnattended: true, rulesChangedSinceTest: false, retrainNeeded: false })
    // the same rules written another way are the same rules
    rules = [{ app: 'mossgrid ', rule: 'throwaway' }, { app: '  QUILLPAD ', rule: 'throwaway' }, { app: 'quillpad', rule: 'keep' }, { app: 'Fernwick', rule: 'sometimes' }]
    expect(svc.status()).toMatchObject({ canRunUnattended: true, rulesChangedSinceTest: false })
    expect((await svc.sortUndecided({ trigger: 'nightly' })).ok).toBe(true)

    const mossgrid = { app: 'Mossgrid', rule: 'throwaway' }
    for (const changed of [[{ app: 'Quillpad', rule: 'keep' }, mossgrid, { app: 'Brightloom', rule: 'throwaway' }], [{ app: 'Quillpad', rule: 'throwaway' }, mossgrid], [{ app: 'Quillpad', rule: 'keep' }], []]) {
      rules = changed
      const st = svc.status()
      expect(st).toMatchObject({ canRunUnattended: false, rulesChangedSinceTest: true, retrainNeeded: false })
      expect(st.report).not.toBeNull() // the report is still shown
    }
    rules = [{ app: 'Brightloom', rule: 'throwaway' }]
    const runsBefore = runCount(w)
    const nightly = await svc.sortUndecided({ trigger: 'nightly' })
    expect(nightly.ok).toBe(false)
    expect(nightly.error).toMatch(/app rules changed/)
    expect(runCount(w)).toBe(runsBefore) // refused before a run is recorded
    expect(await svc.sortUndecided()).toMatchObject({ ok: true, sorted: 3 }) // he is watching: Sort now still works
    expect(await svc.sortManual()).toMatchObject({ ok: true })

    expect((await svc.trainAndTest()).ok).toBe(true)
    expect(svc.status()).toMatchObject({ canRunUnattended: true, rulesChangedSinceTest: false })
    expect((await svc.sortUndecided({ trigger: 'nightly' })).ok).toBe(true)
  })

  it('what the cloud step is told: a rule change is its own answer, apart from "trained enough to sort"', async () => {
    const w = well(70, 30)
    let rules: unknown = []
    let pictureModel = true
    const svc = new SorterService(deps(w, { appRules: () => rules, pictures: { modelReady: () => pictureModel, ensureVectors: async (items) => new Map(items.map((it) => [it.id, vectorFor(it.id)])) } }))
    const gates = cloudGates(svc)
    // nothing trained: not ready, and no rule change to speak of
    expect([gates.canSortLocal(), gates.rulesChangedSinceTest()]).toEqual([false, false])
    expect((await svc.trainAndTest()).ok).toBe(true)
    expect([gates.canSortLocal(), gates.rulesChangedSinceTest()]).toEqual([true, false])
    rules = [{ app: 'Brightloom', rule: 'throwaway' }]
    // a sort he starts is still possible; the mismatch is said separately
    expect([gates.canSortLocal(), gates.rulesChangedSinceTest()]).toEqual([true, true])
    expect(svc.status().canRunUnattended).toBe(false)
    pictureModel = false
    expect(gates.canSortLocal()).toBe(false)
    pictureModel = true
    // too little evidence stays "not trained enough", rules or no rules
    const small = new SorterService(deps(well(24, 12), { appRules: () => rules }))
    rules = []
    expect((await small.trainAndTest()).ok).toBe(true)
    expect([cloudGates(small).canSortLocal(), cloudGates(small).rulesChangedSinceTest()]).toEqual([false, false])
    rules = [{ app: 'Brightloom', rule: 'throwaway' }]
    expect([cloudGates(small).canSortLocal(), cloudGates(small).rulesChangedSinceTest()]).toEqual([false, true])
  })

  it('a report saved before rules were recorded counts as tested with no rules', async () => {
    const w = well(70, 30)
    let rules: unknown = []
    const svc = new SorterService(deps(w, { appRules: () => rules }))
    expect((await svc.trainAndTest()).ok).toBe(true)
    const st = new SorterStore(w)
    const rec = st.latestModel<Record<string, unknown>>()!
    expect(typeof rec.report.appRulesFingerprint).toBe('string')
    const { appRulesFingerprint: _gone, ...older } = rec.report
    st.saveModel({ ...rec, id: 'before-fingerprint', trainedAt: '2099-01-01T00:00:00Z', report: older })
    st.close()
    expect(svc.status()).toMatchObject({ canRunUnattended: true, rulesChangedSinceTest: false, retrainNeeded: false })
    rules = [{ app: 'Brightloom', rule: 'keep' }]
    expect(svc.status()).toMatchObject({ canRunUnattended: false, rulesChangedSinceTest: true })
    expect((await svc.sortUndecided({ trigger: 'nightly' })).ok).toBe(false)
  })

  it('no model, or one from an older sorter version: the flag stays off and the version gate answers', async () => {
    const w = well(70, 30)
    let rules: unknown = []
    const svc = new SorterService(deps(w, { appRules: () => rules }))
    rules = [{ app: 'Brightloom', rule: 'keep' }]
    expect(svc.status()).toMatchObject({ rulesChangedSinceTest: false, canRunUnattended: false, retrainNeeded: false })
    rules = []
    expect((await svc.trainAndTest()).ok).toBe(true)
    const st = new SorterStore(w)
    const rec = st.latestModel<Record<string, unknown>>()!
    st.saveModel({ ...rec, id: 'old', trainedAt: '2099-01-01T00:00:00Z', sorterVersion: 'sorter-local-1', report: { ...rec.report, sorterVersion: 'sorter-local-1' } })
    st.close()
    rules = [{ app: 'Brightloom', rule: 'keep' }]
    expect(svc.status()).toMatchObject({ retrainNeeded: true, rulesChangedSinceTest: false, canRunUnattended: false })
    expect((await svc.sortUndecided({ trigger: 'nightly' })).error).toMatch(/^retrain needed/)
  })
})

describe('sorter service: sort runs and his per-app rules (ticket 20)', () => {
  const read = <T>(w: string, sql: string): T[] => {
    const db = new DatabaseSync(join(w, 'triage.db'), { readOnly: true })
    try {
      return db.prepare(sql).all() as T[]
    } finally {
      db.close()
    }
  }

  it('every sort gets a run record, manual or nightly, and each proposal carries the run that last proposed it', async () => {
    const w = well(70, 30)
    let clock = new Date('2026-10-13T14:20:00Z')
    const svc = new SorterService(deps(w, { now: () => clock }))
    expect((await svc.trainAndTest()).ok).toBe(true)
    const decisionsBefore = read(w, 'SELECT * FROM triage_decisions ORDER BY hash')
    const first = await svc.sortUndecided()
    expect(first).toMatchObject({ ok: true, sorted: 3 })
    const runs1 = read<{ id: string; started_at: string; finished_at: string | null; period: string; trigger: string; sorted: number; keep: number; throwaway: number; doubtful: number }>(w, 'SELECT * FROM sorter_runs')
    expect(runs1).toHaveLength(1)
    expect(runs1[0]).toMatchObject({ started_at: '2026-10-13T14:20:00.000Z', finished_at: '2026-10-13T14:20:00.000Z', period: 'all', trigger: 'manual', sorted: 3, ...first.counts })
    expect(read<{ run_id: string }>(w, 'SELECT run_id FROM sorter_proposals').map((r) => r.run_id)).toEqual([runs1[0].id, runs1[0].id, runs1[0].id])

    clock = new Date('2026-10-14T02:00:00Z')
    const second = await svc.sortUndecided({ trigger: 'nightly', limit: 2 })
    expect(second).toMatchObject({ ok: true, sorted: 2 })
    const runs2 = read<{ id: string; trigger: string; sorted: number }>(w, 'SELECT id, trigger, sorted FROM sorter_runs ORDER BY started_at')
    expect(runs2.map((r) => [r.trigger, r.sorted])).toEqual([['manual', 3], ['nightly', 2]])
    // the two sorted again moved to the new run; the third stays in the first
    const byRun = read<{ run_id: string; n: number }>(w, 'SELECT run_id, COUNT(*) AS n FROM sorter_proposals GROUP BY run_id')
    expect(Object.fromEntries(byRun.map((r) => [r.run_id, Number(r.n)]))).toEqual({ [runs2[0].id]: 1, [runs2[1].id]: 2 })
    // the sorter wrote none of his decisions
    expect(read(w, 'SELECT * FROM triage_decisions ORDER BY hash')).toEqual(decisionsBefore)
  })

  it('a refused sort records no run', async () => {
    const w = well(70, 30)
    const svc = new SorterService(deps(w))
    expect((await svc.sortUndecided()).ok).toBe(false)
    expect(read(w, 'SELECT * FROM sorter_runs')).toEqual([])
  })

  it('the next sort uses his rule for an app; setting it sorts nothing', async () => {
    const w = well(70, 30)
    const t = new DatabaseSync(join(w, 'triage.db'))
    t.exec("UPDATE triage_fts SET app = 'Brightloom' WHERE hash = 'new0'")
    t.close()
    let rules: unknown = []
    const svc = new SorterService(deps(w, { appRules: () => rules }))
    expect((await svc.trainAndTest()).ok).toBe(true)
    await svc.sortUndecided()
    const ruleOf = (): string | null => read<{ rule: string | null }>(w, "SELECT rule FROM sorter_proposals WHERE hash = 'new0'")[0].rule
    const proposedAt = (): string => read<{ proposed_at: string }>(w, "SELECT proposed_at FROM sorter_proposals WHERE hash = 'new0'")[0].proposed_at
    expect(ruleOf()).toBeNull()
    const at = proposedAt()
    rules = [{ app: 'brightloom', rule: 'keep' }]
    expect(proposedAt()).toBe(at) // nothing was sorted again by the change
    await svc.sortUndecided()
    expect(ruleOf()).toBe('your-rule')
  })
})
