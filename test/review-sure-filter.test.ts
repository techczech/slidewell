import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const ipc = new Map<string, (e: { sender: unknown }, ...args: unknown[]) => unknown>()
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: (e: { sender: unknown }, ...args: unknown[]) => unknown) => void ipc.set(channel, fn) } }))
const { registerReviewIpc } = await import('../src/main/review/ipc')
const { ReviewService } = await import('../src/main/review/service')
const { binToken, parseSure, inSure, surePercent } = await import('../src/main/review/piles')
const { certainty } = await import('../src/renderer/src/teach-format')
const { SorterStore } = await import('../src/main/sorter/store')
const { SORTER_VERSION } = await import('../src/main/sorter/decide')
const { seedProposals, teachWell } = await import('./sorter-teach-fixture')

const wells: string[] = []
afterEach(() => {
  for (const w of wells.splice(0)) rmSync(w, { recursive: true, force: true })
})
const NOW = Date.parse('2026-10-13T10:00:00Z')

type Shot = { hash: string; pKeep: number; proposal: 'keep' | 'throwaway' | 'doubtful' }
// "sure" in the name is the percent the card shows; both leans at the 50, 65 and 80 edges
const SHOTS: Shot[] = [
  { hash: 'q50', pKeep: 0.5, proposal: 'doubtful' },
  { hash: 'q55k', pKeep: 0.55, proposal: 'doubtful' },
  { hash: 'q65k', pKeep: 0.65, proposal: 'doubtful' },
  { hash: 'q65t', pKeep: 0.35, proposal: 'doubtful' },
  { hash: 'q66t', pKeep: 0.34, proposal: 'doubtful' },
  { hash: 's80k', pKeep: 0.8, proposal: 'keep' },
  { hash: 's80t', pKeep: 0.2, proposal: 'throwaway' },
  { hash: 's97t', pKeep: 0.03, proposal: 'throwaway' }
]
function well(): string {
  const w = teachWell(0, 0, SHOTS.map((s, i) => ({ hash: s.hash, takenAt: `2026-10-12T09:${String(10 + i)}:00`, app: 'Invented App' })))
  wells.push(w)
  new SorterStore(w).close()
  seedProposals(w, SHOTS.map((s) => ({ ...s, sorterVersion: SORTER_VERSION })))
  return w
}
const service = (w: string): InstanceType<typeof ReviewService> =>
  new ReviewService({ wellRoot: () => w, archiveRoot: () => join(w, 'archive'), sourceRoot: () => null, thumbUrl: () => null, now: () => NOW })
const hashes = (cards: Array<{ hash: string }>): string[] => cards.map((c) => c.hash).sort()

describe('how-sure range: the rules', () => {
  it('compares the whole percent the card shows, from either lean', () => {
    expect(surePercent(0.35)).toBe(65)
    expect(surePercent(0.65)).toBe(65)
    expect(surePercent(0.5)).toBe(50)
    expect(inSure(0.35, { min: 0.65, max: 0.65 })).toBe(true)
    expect(inSure(0.34, { min: 0.5, max: 0.65 })).toBe(false)
    expect(inSure(0.9, undefined)).toBe(true)
  })

  it('accepts only { min, max }: numbers, 0.5 <= min <= max <= 1', () => {
    expect(parseSure({ min: 0.5, max: 1 })).toEqual({ min: 0.5, max: 1 })
    expect(parseSure({ min: 0.7, max: 0.7 })).not.toBeNull()
    for (const bad of [{ min: 0.8, max: 0.6 }, { min: 0.4, max: 0.9 }, { min: 0.5, max: 1.01 }, { min: '0.5', max: 1 }, { min: 0.5, max: Number.NaN }, { min: 0.5, max: Infinity }, { min: 0.5 }, { min: 0.5, max: 1, extra: 1 }, [0.5, 1], null, 'x', 5]) {
      expect(parseSure(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})

describe('how-sure range: the card and the filter read one percent', () => {
  it('pKeep 0.345 shows 65% sure on the card and filters as 65, not 66', () => {
    expect(certainty(0.345, 'throwaway').sure).toBe(65)
    expect(surePercent(0.345)).toBe(65)
    expect(inSure(0.345, { min: 0.65, max: 0.65 })).toBe(true)
    expect(inSure(0.345, { min: 0.66, max: 1 })).toBe(false)
    expect(inSure(0.655, { min: 0.66, max: 0.66 })).toBe(true) // 65.5 rounds up on the keep side: the card shows 66
  })

  it('agrees with the card for every pKeep in steps of 0.0005, at every 5% range end', () => {
    for (let i = 0; i <= 2000; i++) {
      const p = i / 2000
      const shown = certainty(p, p >= 0.5 ? 'keep' : 'throwaway').sure
      expect(surePercent(p), String(p)).toBe(shown)
      for (let lo = 50; lo <= 100; lo += 5) expect(inSure(p, { min: lo / 100, max: 1 }), `${p} from ${lo}`).toBe(shown >= lo)
    }
  })
})

/** SHOTS plus a Bin of four: two the sorter was 97% sure of, two 70%, all proposed throwaway 40 days ago. */
const BIN: Shot[] = [
  { hash: 'b97a', pKeep: 0.03, proposal: 'throwaway' },
  { hash: 'b97b', pKeep: 0.03, proposal: 'throwaway' },
  { hash: 'b70a', pKeep: 0.3, proposal: 'throwaway' },
  { hash: 'b70b', pKeep: 0.3, proposal: 'throwaway' }
]
function binWell(): string {
  const all = [...SHOTS, ...BIN]
  const w = teachWell(0, 0, all.map((s, i) => ({ hash: s.hash, takenAt: `2026-10-12T09:${String(10 + i)}:00`, app: 'Invented App' })))
  wells.push(w)
  new SorterStore(w).close()
  seedProposals(w, SHOTS.map((s) => ({ ...s, sorterVersion: SORTER_VERSION })))
  seedProposals(w, BIN.map((s) => ({ ...s, sorterVersion: SORTER_VERSION, proposedAt: '2026-09-03T08:00:00.000Z' })))
  return w
}

describe('how-sure range: Empty Bin is only ever offered for the whole Bin', () => {
  it('a piles answer under a range carries no Bin token; an unfiltered one carries the whole Bin\'s with its whole count', async () => {
    const svc = service(binWell())
    const part = await svc.piles({ sure: { min: 0.95, max: 1 } })
    expect(hashes(part.bin.items)).toEqual(['b97a', 'b97b'])
    expect(part.bin.total).toBe(2)
    expect(part.bin.token).toBeNull()
    const whole = await svc.piles()
    expect(whole.bin.total).toBe(4)
    expect(whole.bin.token).toBe(binToken(['b97a', 'b97b', 'b70a', 'b70b']))
  })

  it('emptyBin refuses a token for part of the Bin and empties exactly the count the unfiltered answer gave', async () => {
    const svc = service(binWell())
    expect((await svc.emptyBin(binToken(['b97a', 'b97b']))).ok).toBe(false)
    expect((await svc.emptyBin('')).ok).toBe(false)
    const whole = await svc.piles()
    const r = await svc.emptyBin(whole.bin.token!)
    expect(r.ok).toBe(true)
    expect(r.emptied).toBe(whole.bin.total)
    expect((await svc.piles()).bin.total).toBe(0)
  })
})

describe('how-sure range: the service', () => {
  it('overview keeps both ends and both leans, and counts what it shows', async () => {
    const svc = service(well())
    const o = await svc.overview({ sure: { min: 0.5, max: 0.65 } })
    expect(hashes(o.queue)).toEqual(['q50', 'q55k', 'q65k', 'q65t'])
    expect(o.needALook).toBe(4)
    expect(o.confident).toEqual({ kept: 0, throwaway: 0 })
    expect(o.all).toEqual({ needALook: 5, confident: 3 })
    const hi = await svc.overview({ sure: { min: 0.8, max: 1 } })
    expect(hi.needALook).toBe(0)
    expect(hi.confident).toEqual({ kept: 1, throwaway: 2 })
    expect(hashes(hi.confidentSample)).toEqual(['s80k', 's80t', 's97t'])
    const one = await svc.overview({ sure: { min: 0.66, max: 0.66 } })
    expect(hashes(one.queue)).toEqual(['q66t'])
  })

  it('no range changes nothing', async () => {
    const o = await service(well()).overview({})
    expect(o.needALook).toBe(5)
    expect(o.all).toEqual({ needALook: 5, confident: 3 })
  })

  it('piles and pages are filtered, and their totals say so', async () => {
    const svc = service(well())
    const p = await svc.piles({ sure: { min: 0.8, max: 0.9 } })
    expect(hashes(p.kept.items)).toEqual(['s80k'])
    expect(hashes(p.throwaway.items)).toEqual(['s80t'])
    expect(p.kept.total).toBe(1)
    const unfiltered = await svc.piles()
    expect(unfiltered.throwaway.total).toBe(2)
    expect((await svc.page('throwaway', null, 10, { min: 0.9, max: 1 })).items.map((c) => c.hash)).toEqual(['s97t'])
    expect(p.bin.token).toBeNull()
  })

  it('refuses a bad range that reaches it, never clamps', async () => {
    const svc = service(well())
    await expect(svc.overview({ sure: { min: 0.9, max: 0.6 } })).rejects.toThrow(/how-sure/)
    await expect(svc.piles({ sure: { min: 0.1, max: 0.6 } })).rejects.toThrow(/how-sure/)
    await expect(svc.page('kept', null, 10, 'x')).rejects.toThrow(/how-sure/)
  })

  it('does not filter the teaching queue', async () => {
    const q = await service(well()).teachQueue()
    expect(q.total).toBe(5)
  })
})

describe('how-sure range: IPC', () => {
  const sender = { id: 1 }
  const call = (channel: string, ...args: unknown[]): unknown => ipc.get(channel)!({ sender }, ...args)
  let calls: Array<[string, unknown]>
  beforeEach(() => {
    ipc.clear()
    calls = []
    registerReviewIpc({ overview: (o: unknown) => (calls.push(['overview', o]), 'o'), piles: (o: unknown) => (calls.push(['piles', o]), 'p'), page: (...a: unknown[]) => (calls.push(['page', a]), 'g') } as never, (s) => s === sender)
  })

  it('passes a good range to overview, piles and page', () => {
    const sure = { min: 0.5, max: 0.65 }
    expect(call('review:overview', { queue: 50, sure })).toBe('o')
    expect(call('review:piles', { kept: 60, sure })).toBe('p')
    expect(call('review:page', 'kept', null, 60, sure)).toBe('g')
    expect(calls[0][1]).toMatchObject({ sure })
    expect(calls[2][1]).toEqual(['kept', null, 60, sure])
  })

  it('refuses bad ranges in every channel that takes one', () => {
    for (const bad of [{ min: 0.8, max: 0.6 }, { min: 0.2, max: 0.6 }, { min: 0.5, max: 1.5 }, { min: '0.5', max: 1 }, { min: 0.5, max: 1, x: 1 }, { min: 0.5 }, 0.6, null]) {
      expect(() => call('review:overview', { sure: bad }), JSON.stringify(bad)).toThrow('review:overview: bad arguments')
      expect(() => call('review:piles', { sure: bad })).toThrow('review:piles: bad arguments')
      expect(() => call('review:page', 'kept', null, 60, bad)).toThrow('review:page: bad arguments')
    }
    expect(calls).toEqual([])
  })
})
