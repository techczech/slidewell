import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))
const { SorterService } = await import('../src/main/sorter/service')
const { train } = await import('../src/main/sorter/classifier')
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
    const w = well(12, 6) // held back: 3 kept + 2 binned
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
  it('stopping while the trainer runs returns cancelled, ends the trainer and saves nothing', async () => {
    const w = well(70, 30)
    let sawAbort = false
    let calls = 0
    let started: () => void = () => undefined
    const running = new Promise<void>((r) => (started = r))
    const svc = new SorterService(
      deps(w, {
        // a trainer that runs until it is told to stop (as the worker does)
        train: (_xs, signal) =>
          new Promise((_resolve, reject) => {
            calls++
            started()
            signal.addEventListener('abort', () => {
              sawAbort = true
              reject(new Error('cancelled'))
            })
          })
      })
    )
    const run = svc.trainAndTest()
    await running
    svc.cancel()
    const r = await run
    expect(r).toMatchObject({ ok: false, cancelled: true })
    expect(sawAbort).toBe(true)
    expect(calls).toBe(1) // no further fit after Stop
    expect(models(w)).toBe(0)
    expect(svc.status().phase).toBe('idle')
  })

  it('stopping just as a fit finishes still saves nothing', async () => {
    const w = well(70, 30)
    let svc: InstanceType<typeof SorterService> | null = null
    svc = new SorterService(
      deps(w, {
        train: async (xs) => {
          const m = train(xs, { epochs: 50, l2: 1e-3 })
          svc!.cancel() // Stop pressed while this fit was finishing: its result must not be used
          return m
        }
      })
    )
    const r = await svc.trainAndTest()
    expect(r).toMatchObject({ ok: false, cancelled: true })
    expect(models(w)).toBe(0)
  })
})
