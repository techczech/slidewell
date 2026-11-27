// The Triage import control's state (idle → working → done/failed), the main-side runner that emits it,
// and the real promote loop's progress order on scratch folders with invented file names.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IDLE, adoptStatus, applySnapshot, failureMessage, importButtonLabel, importLine, startClick, type ImportSnapshot } from '../src/main/triage-import-progress'
import { createImportRunner } from '../src/main/triage-import-run'

vi.mock('../src/main/well', () => ({
  ocrImage: async () => '',
  ingestScreenshot: async (_a: string, _w: string, p: string) => {
    if (p.includes('throws')) throw new Error('synthetic disk failure')
    return p.includes('broken') ? null : { id: `id-${p.slice(-6)}`, relPath: `images/${p.slice(-6)}`, created: true, sourceHash: 'x' }
  },
  ingestVideo: async () => null,
  makePoster: async () => false,
  recordWellSource: async () => undefined
}))
const { scanTriageSource, setTriageDecision, importSelectedTriage } = await import('../src/main/triage')

describe('import control state', () => {
  it('a click goes to working at once; a second click while working is ignored', () => {
    const a = startClick(IDLE)
    expect(a).toEqual({ state: { phase: 'working', done: 0, total: 0 }, start: true })
    expect(startClick(a.state).start).toBe(false)
    expect(importButtonLabel(a.state, 5)).toBe('Importing…')
    expect(importButtonLabel(IDLE, 5)).toBe('⤓ Import 5 → well')
  })
  it('counts move forward and never back', () => {
    let s = startClick(IDLE).state
    expect(importLine(s)).toBe('Getting ready to import…')
    s = applySnapshot(s, { phase: 'working', done: 0, total: 48 })
    s = applySnapshot(s, { phase: 'working', done: 12, total: 48 })
    s = applySnapshot(s, { phase: 'working', done: 5, total: 48 })
    expect(importLine(s)).toBe('Importing 12 of 48…')
  })
  it('result lines', () => {
    expect(importLine({ phase: 'done', imported: 46, skipped: 2, gated: 0 })).toBe('Imported 46. Skipped 2 (file unavailable, unreadable or decision changed).')
    expect(importLine({ phase: 'done', imported: 3, skipped: 0, gated: 1 })).toBe('Imported 3. 1 video is over the 20 MB limit and stays selected.')
    expect(importLine({ phase: 'done', imported: 0, skipped: 0, gated: 0 })).toBe('Nothing to import.')
    expect(importLine({ phase: 'failed', message: 'x' })).toBe('x')
    expect(importLine(IDLE)).toBe('')
    expect(failureMessage(new Error('disk full.'))).toBe('The import stopped before it finished (disk full). Anything already imported is kept; the rest stays selected.')
    expect(failureMessage(undefined)).toContain('stopped before it finished.')
  })
  it('a run already going is adopted; an old result is not replayed', () => {
    const w: ImportSnapshot = { phase: 'working', done: 7, total: 20 }
    expect(adoptStatus(w)).toEqual(w)
    expect(startClick(adoptStatus(w)).start).toBe(false)
    expect(adoptStatus({ phase: 'done', imported: 1, skipped: 0, gated: 0 })).toEqual(IDLE)
    expect(adoptStatus(null)).toEqual(IDLE)
  })
})

describe('import runner (main)', () => {
  it('emits working snapshots in order, then done; status follows', async () => {
    const seen: ImportSnapshot[] = []
    const r = createImportRunner({
      emit: (s) => seen.push(s),
      work: async (step) => {
        step(0, 3)
        step(1, 3)
        step(2, 3)
        step(3, 3)
        return { imported: 2, skipped: 1, gated: 0 }
      }
    })
    const out = await r.start()
    expect(out).toEqual({ imported: 2, skipped: 1, gated: 0 })
    expect(seen.map((s) => (s.phase === 'working' ? `${s.done}/${s.total}` : s.phase))).toEqual(['0/0', '0/3', '1/3', '2/3', '3/3', 'done'])
    expect(r.status()).toEqual({ phase: 'done', imported: 2, skipped: 1, gated: 0 })
  })
  it('a second start while running joins the first run', async () => {
    let calls = 0
    let release: () => void = () => {}
    const r = createImportRunner({
      emit: () => {},
      work: async () => {
        calls++
        await new Promise<void>((res) => (release = res))
        return { imported: 1, skipped: 0, gated: 0 }
      }
    })
    const a = r.start()
    const b = r.start()
    expect(r.status()?.phase).toBe('working')
    release()
    expect(await a).toEqual(await b)
    expect(calls).toBe(1)
  })
  it('a throw ends in failed with one sentence, and a new run can start', async () => {
    let fail = true
    const seen: ImportSnapshot[] = []
    const r = createImportRunner({
      emit: (s) => seen.push(s),
      work: async () => {
        if (fail) throw new Error('database is locked')
        return { imported: 0, skipped: 0, gated: 0 }
      }
    })
    const out = await r.start()
    expect(out.error).toContain('database is locked')
    expect(seen[seen.length - 1]).toEqual({ phase: 'failed', message: out.error })
    fail = false
    expect((await r.start()).error).toBeUndefined()
  })
})

const dirs: string[] = []
let dir = ''
beforeEach(() => {
  mkdirSync('out', { recursive: true })
  dir = mkdtempSync(join(process.cwd(), 'out', 'triage-progress-test-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'Shots'))
  mkdirSync(join(dir, 'well'))
})
afterAll(() => { for (const path of dirs) rmSync(path, { recursive: true, force: true }) })

describe('promote loop progress (real triage db, fake files)', () => {
  it('reports 0 then one step per file, in order, and the counts match', async () => {
    const src = realpathSync(join(dir, 'Shots'))
    const well = join(dir, 'well')
    for (const f of ['alpha.png', 'beta.png', 'gamma.png', 'broken.png']) writeFileSync(join(src, f), `bytes of ${f}`)
    await scanTriageSource('/nonexistent', well, src)
    const { query } = await import('../src/main/sqlite')
    const hashes = (await query<{ hash: string }>(join(well, 'triage.db'), 'SELECT DISTINCT hash FROM triage_fts', [])).map((r) => r.hash)
    expect(hashes.length).toBe(4)
    for (const h of hashes) await setTriageDecision('/nonexistent', well, src, h, 'select')
    const steps: string[] = []
    const r = await importSelectedTriage('/nonexistent', well, src, [], (d, t) => steps.push(`${d}/${t}`))
    expect(steps).toEqual(['0/4', '1/4', '2/4', '3/4', '4/4'])
    expect(r).toEqual({ imported: 3, skipped: 1, gated: 0 })
  }, 30_000)
})

it('counts and names a failed item, preserves its original and continues the batch', async () => {
  const src = realpathSync(join(dir, 'Shots'))
  const well = join(dir, 'well')
  const failed = join(src, 'throws.png')
  const good = join(src, 'good.png')
  writeFileSync(failed, 'failed media')
  // Make the failing row sort first by content hash.
  writeFileSync(good, 'healthy media 0')
  await scanTriageSource('/nonexistent', well, src)
  const { query } = await import('../src/main/sqlite')
  const hashes = (await query<{ hash: string; rel_path: string }>(join(well, 'triage.db'), 'SELECT hash, rel_path FROM triage_fts ORDER BY hash'))
  expect(hashes[0].rel_path).toBe('throws.png')
  for (const row of hashes) await setTriageDecision('/nonexistent', well, src, row.hash, 'select')
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(await importSelectedTriage('/nonexistent', well, src)).toEqual({ imported: 1, skipped: 1, gated: 0 })
    expect(log.mock.calls.some(([line]) => typeof line === 'string' && line.includes('import failed') && line.includes('throws.png'))).toBe(true)
    expect(readFileSync(failed, 'utf8')).toBe('failed media')
    expect(readFileSync(good, 'utf8')).toBe('healthy media 0')
    const decision = await query<{ state: string; well_id: string | null }>(
      join(well, 'triage.db'), 'SELECT state, well_id FROM triage_decisions WHERE hash = ?', [hashes[0].hash]
    )
    expect(decision).toEqual([{ state: 'selected', well_id: null }])
  } finally {
    log.mockRestore()
  }
}, 30_000)
