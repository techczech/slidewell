// The period a manual sort is limited to (src/main/sorter/period.ts) and the local sorter under it:
// the period → cut-off function with a fixed clock (boundaries, a summer-time change, no date), which
// undecided screenshots "Sort undecided screenshots now" writes a proposal for under each period, and
// the IPC that stores the period (an unknown one is refused, never read as everything).
// Synthetic data only; invented names.
process.env.TZ = 'Europe/London' // the summer-time tests below need a zone that has one; set before any Date is made

import { describe, it, expect, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ipc = vi.hoisted(() => new Map<string, (e: { sender: unknown }, ...args: unknown[]) => unknown>())
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: (e: { sender: unknown }, ...args: unknown[]) => unknown) => void ipc.set(channel, fn) } }))
const { SORT_PERIODS, EVERYTHING, PERIOD_REFUSED, PERIOD_UNREADABLE, cutoffFor, inWindow, isSortPeriod, periodLabel, periodNote, periodPhrase, periodPrefix, periodWindow, storedPeriod, upperFor, usableTakenAt } = await import('../src/main/sorter/period')
const { SorterService, changePeriod, registerSorterIpc } = await import('../src/main/sorter/service')
const { triageImageId } = await import('../src/main/picture-search/vector-store')
type Deps = ConstructorParameters<typeof SorterService>[0]

/** A local time, as the clock on the wall shows it. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date => new Date(y, mo - 1, d, h, mi, s)
const NOW = at(2026, 10, 12, 16, 0, 0)

describe('the periods', () => {
  it('are these four, in this order, with these words', () => {
    expect([...SORT_PERIODS]).toEqual(['7d', '30d', '90d', 'all'])
    expect(SORT_PERIODS.map(periodLabel)).toEqual(['Last 7 days', 'Last 30 days', 'Last 90 days', 'Everything'])
    expect(SORT_PERIODS.map(periodPhrase)).toEqual([' from the last 7 days', ' from the last 30 days', ' from the last 90 days', ''])
    expect(SORT_PERIODS.map(periodPrefix)).toEqual(['Last 7 days: ', 'Last 30 days: ', 'Last 90 days: ', ''])
    expect(periodNote('30d')).toBe('Period: the last 30 days, by the date in each file name. Screenshots taken before that, or with no date in their name, are not sorted or sent and stay as they are.')
    expect(periodNote('all')).toBe('Period: everything, whatever the date.')
  })

  it('anything else is not a period, and is never read as everything', () => {
    for (const x of ['everything', 'ALL', 'all ', '', '365d', '7', 7, 30, true, null, undefined, {}, ['7d'], { period: 'all' }, '2020-01-01T00:00:00', '__proto__', 'toString']) {
      expect(isSortPeriod(x)).toBe(false)
      expect(periodWindow(x, NOW)).toBeNull()
    }
    // config: nothing stored is the default (everything); something stored that is not a period is unreadable
    expect(storedPeriod(undefined)).toBe('all')
    expect(storedPeriod('30d')).toBe('30d')
    // only an absent value is the default: an explicit null is something stored that is not a period
    for (const x of [null, '', 'everything', 30, 0, false, {}, [], '365d']) expect(storedPeriod(x)).toBeNull()
  })
})

describe('period → cut-off, with a fixed clock', () => {
  it('is the same time of day, that many calendar days earlier; everything has none', () => {
    expect(cutoffFor('7d', NOW)).toBe('2026-10-05T16:00:00')
    expect(cutoffFor('30d', NOW)).toBe('2026-09-12T16:00:00')
    expect(cutoffFor('90d', NOW)).toBe('2026-07-14T16:00:00')
    expect(cutoffFor('all', NOW)).toBeNull()
    // a limited window is frozen with an upper bound too: one day after the moment it was made
    expect(periodWindow('30d', NOW)).toEqual({ period: '30d', cutoff: '2026-09-12T16:00:00', upper: '2026-10-13T16:00:00' })
    expect(periodWindow('7d', NOW)).toEqual({ period: '7d', cutoff: '2026-10-05T16:00:00', upper: '2026-10-13T16:00:00' })
    expect(periodWindow('all', NOW)).toEqual(EVERYTHING)
    expect(EVERYTHING).toEqual({ period: 'all', cutoff: null, upper: null })
    expect(upperFor('7d', at(2026, 12, 31, 23, 59, 59))).toBe('2027-01-01T23:59:59')
    expect(upperFor('90d', at(2028, 2, 28, 8, 0, 0))).toBe('2028-02-29T08:00:00')
    expect(upperFor('all', NOW)).toBeNull()
  })

  it('crosses month and year ends and a leap day', () => {
    expect(cutoffFor('7d', at(2026, 1, 3, 0, 0, 5))).toBe('2025-12-27T00:00:05')
    expect(cutoffFor('30d', at(2028, 3, 15, 23, 59, 59))).toBe('2028-02-14T23:59:59') // February 2028 has 29 days
    expect(cutoffFor('90d', at(2027, 3, 1, 8, 30, 0))).toBe('2026-12-01T08:30:00')
  })

  it('the boundary: at the cut-off is inside, one second before it is outside', () => {
    const w = periodWindow('7d', NOW)!
    expect(inWindow('2026-10-05T16:00:00', w)).toBe(true)
    expect(inWindow('2026-10-05T15:59:59', w)).toBe(false)
    expect(inWindow('2026-10-05T16:00:01', w)).toBe(true)
    expect(inWindow('2026-10-12T16:00:00', w)).toBe(true) // now
    // a name dated a little ahead of this Mac's clock is taken, up to one day (a clock that is off); beyond that it is not in the period
    expect(inWindow('2026-10-12T18:00:00', w)).toBe(true)
    expect(inWindow('2026-10-13T16:00:00', w)).toBe(true) // exactly one day ahead
    expect(inWindow('2026-10-13T16:00:01', w)).toBe(false)
    expect(inWindow('2026-10-20T10:00:00', w)).toBe(false)
    for (const p of ['7d', '30d', '90d'] as const) expect(inWindow('2099-01-01T00:00:00', periodWindow(p, NOW)!)).toBe(false)
    expect(inWindow('2099-01-01T00:00:00', periodWindow('all', NOW)!)).toBe(true) // everything has no upper bound
    expect(inWindow('2025-10-10T16:00:00', w)).toBe(false) // same day a year earlier
  })

  it('a summer-time change inside the period does not move the cut-off', () => {
    expect(at(2026, 10, 27, 10).getTimezoneOffset()).toBe(0) // the zone took effect: GMT after 25 October 2026
    expect(at(2026, 10, 20, 10).getTimezoneOffset()).toBe(-60) // and BST before it
    // clocks went back on 25 October 2026: seven days earlier on the clock is 168 + 1 hours earlier
    expect(cutoffFor('7d', at(2026, 10, 27, 10, 0, 0))).toBe('2026-10-20T10:00:00')
    const autumn = periodWindow('7d', at(2026, 10, 27, 10, 0, 0))!
    expect(inWindow('2026-10-20T10:00:00', autumn)).toBe(true)
    expect(inWindow('2026-10-20T09:59:59', autumn)).toBe(false)
    // clocks went forward on 29 March 2026 (01:00 → 02:00): the cut-off may name a time that was skipped
    expect(cutoffFor('7d', at(2026, 4, 5, 1, 30, 0))).toBe('2026-03-29T01:30:00')
    const spring = periodWindow('7d', at(2026, 4, 5, 1, 30, 0))!
    expect(inWindow('2026-03-29T00:59:59', spring)).toBe(false)
    expect(inWindow('2026-03-29T02:00:00', spring)).toBe(true)
    // 30 and 90 days across the same changes
    expect(cutoffFor('30d', at(2026, 11, 10, 9, 15, 0))).toBe('2026-10-11T09:15:00')
    expect(cutoffFor('90d', at(2026, 5, 1, 9, 15, 0))).toBe('2026-01-31T09:15:00')
  })

  it('a screenshot with no usable date is inside everything and no other period', () => {
    for (const bad of ['', '   ', 'yesterday', '2026-10-10', '2026-10-10 12:00:00', '2026-13-01T10:00:00', '2026-02-30T10:00:00', '2026-10-10T25:00:00', '9999', 'z', null, undefined, 20261010]) {
      expect(usableTakenAt(bad)).toBe(false)
      for (const p of ['7d', '30d', '90d'] as const) expect(inWindow(bad, periodWindow(p, NOW)!)).toBe(false)
      expect(inWindow(bad, EVERYTHING)).toBe(true)
    }
    expect(usableTakenAt('2028-02-29T10:00:00')).toBe(true)
    expect(usableTakenAt('2027-02-29T10:00:00')).toBe(false)
  })

  it('a window that is not everything and has no usable cut-off takes nothing', () => {
    const upper = '2026-10-13T16:00:00'
    expect(inWindow('2026-10-10T10:00:00', { period: '7d', cutoff: '2026-10-05T16:00:00', upper })).toBe(true)
    expect(inWindow('2026-10-10T10:00:00', { period: '7d', cutoff: null, upper })).toBe(false)
    expect(inWindow('2026-10-10T10:00:00', { period: '7d', cutoff: '', upper })).toBe(false)
    expect(inWindow('2026-10-10T10:00:00', { period: 'all', cutoff: '1970-01-01T00:00:00', upper: null })).toBe(false)
    // nor does one with no usable upper bound, or an everything that carries one
    expect(inWindow('2026-10-10T10:00:00', { period: '7d', cutoff: '2026-10-05T16:00:00', upper: null })).toBe(false)
    expect(inWindow('2026-10-10T10:00:00', { period: '7d', cutoff: '2026-10-05T16:00:00', upper: '' })).toBe(false)
    expect(inWindow('2026-10-10T10:00:00', { period: '7d', cutoff: '2026-10-05T16:00:00' } as never)).toBe(false)
    expect(inWindow('2026-10-10T10:00:00', { period: 'all', cutoff: null, upper })).toBe(false)
  })
})

// --- the local sorter under a period ---

/** Undecided screenshots by name → capture time ('' = the file name carries no date). */
const UNDECIDED: Record<string, string> = {
  newRecent: '2026-10-10T09:00:00',
  newEdge: '2026-10-05T16:00:00', // exactly seven days before NOW
  newJustOut: '2026-10-05T15:59:59',
  newMonth: '2026-09-20T10:00:00',
  newQuarter: '2026-08-01T10:00:00',
  newOld: '2025-01-01T10:00:00',
  newNoDate: '',
  newBadDate: 'last tuesday',
  newFuture: '2099-01-01T00:00:00' // a name dated far ahead: inside everything and no other period
}

function makeWell(kept = 70, binned = 30): string {
  const well = mkdtempSync(join(tmpdir(), 'sw-sorter-period-'))
  const src = join(well, 'source')
  mkdirSync(src, { recursive: true })
  const t = new DatabaseSync(join(well, 'triage.db'))
  t.exec(`CREATE VIRTUAL TABLE triage_fts USING fts5(hash UNINDEXED, kind UNINDEXED, rel_path UNINDEXED, filename, ext UNINDEXED, size UNINDEXED, mtime UNINDEXED,
            poster_rel UNINDEXED, offline UNINDEXED, ocr_text, scanned_at UNINDEXED, source UNINDEXED, taken_at UNINDEXED, app, window_title);
          CREATE TABLE triage_decisions (hash TEXT PRIMARY KEY, state TEXT NOT NULL, decided_at TEXT, well_id TEXT);`)
  const row = t.prepare("INSERT INTO triage_fts (hash, kind, rel_path, filename, ext, offline, ocr_text, source, taken_at, app, window_title) VALUES (?, 'image', ?, ?, 'png', '0', '', ?, ?, '', '')")
  const dec = t.prepare('INSERT INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, ?, ?, NULL)')
  const add = (hash: string, state: string | null, takenAt: string): void => {
    writeFileSync(join(src, `${hash}.png`), Buffer.alloc(64, hash.length))
    row.run(hash, `${hash}.png`, `${hash}.png`, src, takenAt)
    if (state) dec.run(hash, state, '2026-10-01')
  }
  for (let i = 0; i < kept; i++) add(`keep${i}`, 'included', '')
  for (let i = 0; i < binned; i++) add(`bin${i}`, 'excluded', '')
  for (const [name, takenAt] of Object.entries(UNDECIDED)) add(name, null, takenAt)
  t.close()
  return well
}

function vectorFor(id: string): Float32Array {
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

let wells: string[] = []
afterEach(() => {
  for (const w of wells) rmSync(w, { recursive: true, force: true })
  wells = []
  ipc.clear()
})

/** A trained service on a fresh well; `box.period` is what config holds; `embedded` collects every picture id read while sorting. */
async function trained(period?: unknown): Promise<{ svc: InstanceType<typeof SorterService>; well: string; box: { period: unknown }; embedded: Set<string> }> {
  const well = makeWell()
  wells.push(well)
  const box = { period }
  const embedded = new Set<string>()
  const deps: Deps = {
    wellRoot: () => well,
    pictures: {
      modelReady: () => true,
      ensureVectors: async (items) => {
        for (const it of items) embedded.add(it.id)
        return new Map(items.map((it) => [it.id, vectorFor(it.id)]))
      }
    },
    broadcast: () => undefined,
    period: () => box.period,
    now: () => NOW
  }
  const svc = new SorterService(deps)
  expect((await svc.trainAndTest()).ok).toBe(true)
  embedded.clear()
  return { svc, well, box, embedded }
}
const proposed = (well: string): string[] => {
  const db = new DatabaseSync(join(well, 'triage.db'), { readOnly: true })
  try {
    return (db.prepare('SELECT hash FROM sorter_proposals ORDER BY hash').all() as Array<{ hash: string }>).map((r) => r.hash)
  } finally {
    db.close()
  }
}
const ALL = Object.keys(UNDECIDED).sort()

describe('“Sort undecided screenshots now” under each period', () => {
  const cases: Array<[unknown, string[], string]> = [
    ['7d', ['newEdge', 'newRecent'], ' from the last 7 days'],
    ['30d', ['newEdge', 'newJustOut', 'newMonth', 'newRecent'], ' from the last 30 days'],
    ['90d', ['newEdge', 'newJustOut', 'newMonth', 'newQuarter', 'newRecent'], ' from the last 90 days'],
    ['all', ALL, ''],
    [undefined, ALL, ''] // nothing stored: everything, as before there was a choice
  ]
  for (const [period, expected, phrase] of cases) {
    it(`${String(period)}: a proposal is written for the screenshots in the period and for no other`, async () => {
      const { svc, well, embedded } = await trained(period)
      expect(svc.status().period).toBe(period ?? 'all')
      const r = await svc.sortManual()
      expect(r).toMatchObject({ ok: true, sorted: expected.length, period: period ?? 'all', periodPhrase: phrase })
      expect(proposed(well)).toEqual(expected)
      // a screenshot outside the period is not even read
      const outside = ALL.filter((n) => !expected.includes(n))
      for (const n of expected) expect(embedded.has(triageImageId(n))).toBe(true)
      for (const n of outside) expect(embedded.has(triageImageId(n))).toBe(false)
    })
  }

  it('the count limit applies inside the period', async () => {
    const { svc, well } = await trained('30d')
    expect(await svc.sortManual({ limit: 2 })).toMatchObject({ ok: true, sorted: 2 })
    for (const h of proposed(well)) expect(['newEdge', 'newJustOut', 'newMonth', 'newRecent']).toContain(h)
  })

  it('a stored period that is not a period sorts nothing (it is not everything)', async () => {
    for (const bad of ['everything', '365d', 30, { period: 'all' }, '', null]) {
      const { svc, well, embedded } = await trained(bad)
      expect(svc.status().period).toBeNull()
      expect(await svc.sortManual()).toEqual({ ok: false, error: PERIOD_UNREADABLE })
      expect(proposed(well)).toEqual([])
      expect(embedded.size).toBe(0)
    }
  })

  it('without a window (the nightly run) it sorts everything, whatever period is stored', async () => {
    const { svc, well } = await trained('7d')
    expect(await svc.sortUndecided()).toMatchObject({ ok: true, sorted: ALL.length, period: 'all' })
    expect(proposed(well)).toEqual(ALL)
  })

  it('a window whose period is not one of the four is refused', async () => {
    const { svc, well } = await trained('7d')
    expect(await svc.sortUndecided({ window: { period: 'everything' as never, cutoff: null, upper: null } })).toEqual({ ok: false, error: PERIOD_REFUSED })
    expect(proposed(well)).toEqual([])
  })
})

describe('the period from the renderer (IPC)', () => {
  const sender = {}
  const call = (channel: string, ...args: unknown[]): unknown => ipc.get(channel)!({ sender }, ...args)

  it('changePeriod stores one of the four and refuses anything else, leaving what is stored', () => {
    const box: { period: unknown } = { period: '30d' }
    let changes = 0
    const set = (p: unknown) => changePeriod(p, () => box.period, (v) => void (box.period = v), () => void changes++)
    for (const bad of ['everything', 'ALL', '', '365d', 7, null, undefined, {}, ['all'], { period: 'all' }, '1970-01-01T00:00:00']) {
      expect(set(bad)).toEqual({ ok: false, period: '30d', error: PERIOD_REFUSED })
      expect(box.period).toBe('30d')
    }
    expect(changes).toBe(0)
    expect(set('7d')).toEqual({ ok: true, period: '7d' })
    expect(box.period).toBe('7d')
    expect(changes).toBe(1)
    expect(set('7d')).toEqual({ ok: true, period: '7d' }) // the same one again is no change
    expect(changes).toBe(1)
    expect(set('all')).toEqual({ ok: true, period: 'all' })
    expect(changes).toBe(2)
  })

  it('sorter:set-period refuses an unknown period; sorter:sort then still uses the stored one', async () => {
    const { svc, well, box } = await trained('7d')
    registerSorterIpc(svc, (s) => s === sender, (p) => changePeriod(p, () => box.period, (v) => void (box.period = v), () => svc.notify()))
    expect(call('sorter:set-period', 'everything')).toMatchObject({ ok: false, period: '7d' })
    expect(call('sorter:set-period', { period: 'all', cutoff: '1970-01-01T00:00:00' })).toMatchObject({ ok: false, period: '7d' })
    expect(box.period).toBe('7d')
    expect(() => ipc.get('sorter:set-period')!({ sender: {} }, 'all')).toThrow(/not allowed/) // another window cannot set it
    // the sort takes no period, date or list from the renderer: extra fields are not read
    expect(await call('sorter:sort', { period: 'all', window: { period: 'all', cutoff: null }, cutoff: '1970-01-01T00:00:00', hashes: ALL })).toMatchObject({ ok: true, sorted: 2, period: '7d' })
    expect(proposed(well)).toEqual(['newEdge', 'newRecent'])
    expect(call('sorter:set-period', '30d')).toEqual({ ok: true, period: '30d' })
    expect(svc.status().period).toBe('30d')
  })
})
