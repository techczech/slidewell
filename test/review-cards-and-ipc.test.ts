import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const ipc = new Map<string, (e: { sender: unknown }, ...args: unknown[]) => unknown>()
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: (e: { sender: unknown }, ...args: unknown[]) => unknown) => void ipc.set(channel, fn) } }))
const { registerReviewIpc } = await import('../src/main/review/ipc')
const { ReviewService } = await import('../src/main/review/service')
const { SorterStore } = await import('../src/main/sorter/store')
const { SORTER_VERSION } = await import('../src/main/sorter/decide')
const { addShots, countRows, proposalsOf, seedProposals, teachWell } = await import('./sorter-teach-fixture')

const wells: string[] = []
afterEach(() => {
  for (const w of wells.splice(0)) rmSync(w, { recursive: true, force: true })
})

const NOW = Date.parse('2026-10-13T10:00:00Z')

/**
 * Screenshots in every place Review can show or hide one: kept and thrown away by the sorter, still
 * doubtful, kept by him, in the Bin (thrown away more than 30 days ago), emptied from the Bin, and one
 * the sorter never proposed anything for.
 */
function well(): string {
  const names = ['sure-keep', 'sure-toss', 'unsure', 'his-keep', 'binned', 'emptied', 'never-sorted']
  const w = teachWell(0, 0, names.map((hash) => ({ hash, takenAt: '2026-10-12T09:00:00', app: 'Invented App' })))
  wells.push(w)
  new SorterStore(w).close()
  seedProposals(w, [
    { hash: 'sure-keep', proposal: 'keep', pKeep: 0.93, sorterVersion: SORTER_VERSION },
    { hash: 'sure-toss', proposal: 'throwaway', pKeep: 0.04, sorterVersion: SORTER_VERSION, proposedAt: '2026-10-10T08:00:00.000Z' },
    { hash: 'unsure', proposal: 'doubtful', pKeep: 0.55, sorterVersion: SORTER_VERSION },
    { hash: 'his-keep', proposal: 'doubtful', pKeep: 0.5, sorterVersion: SORTER_VERSION },
    { hash: 'binned', proposal: 'throwaway', pKeep: 0.03, sorterVersion: SORTER_VERSION, proposedAt: '2026-08-01T08:00:00.000Z' },
    { hash: 'emptied', proposal: 'throwaway', pKeep: 0.03, sorterVersion: SORTER_VERSION }
  ])
  addShots(w, [{ hash: 'his-keep', state: 'included' }, { hash: 'emptied', state: 'emptied' as never }])
  return w
}

const service = (w: string): InstanceType<typeof ReviewService> =>
  new ReviewService({ wellRoot: () => w, archiveRoot: () => join(w, 'archive'), sourceRoot: () => null, thumbUrl: (abs) => (abs ? `swthumb://t/${abs.split('/').pop()}` : null), now: () => NOW })

describe('review cards by hash', () => {
  it('answers the cards asked for, in that order, with the shape the piles give', async () => {
    const svc = service(well())
    const cards = await svc.cards(['sure-toss', 'his-keep', 'sure-keep', 'unsure'])
    expect(cards.map((c) => [c.hash, c.pile, c.by])).toEqual([['sure-toss', 'throwaway', 'sorter'], ['his-keep', 'kept', 'you'], ['sure-keep', 'kept', 'sorter'], ['unsure', 'doubtful', 'sorter']])
    const piles = await svc.piles()
    expect(cards[2]).toEqual(piles.kept.items.find((c) => c.hash === 'sure-keep'))
    expect(cards[0]).toEqual(piles.throwaway.items.find((c) => c.hash === 'sure-toss'))
    expect(cards[0]).toMatchObject({ app: 'Invented App', thumbUrl: 'swthumb://t/sure-toss.png', binInDays: 27 })
  })

  it('leaves out what is in the Bin, was emptied, was never sorted, or is not there at all', async () => {
    const svc = service(well())
    expect((await svc.piles()).bin.items.map((c) => c.hash)).toEqual(['binned'])
    expect((await svc.cards(['binned', 'emptied', 'never-sorted', 'no-such-shot', 'sure-keep'])).map((c) => c.hash)).toEqual(['sure-keep'])
    expect(await svc.cards([])).toEqual([])
  })

  it('answers each screenshot once, at most 200 of them, and skips anything that is not a hash', async () => {
    const shots = Array.from({ length: 230 }, (_, i) => ({ hash: `shot-${String(i).padStart(3, '0')}` }))
    const w = teachWell(0, 0, shots)
    wells.push(w)
    new SorterStore(w).close()
    seedProposals(w, shots.map((s) => ({ hash: s.hash, proposal: 'keep' as const, pKeep: 0.9, sorterVersion: SORTER_VERSION })))
    const svc = service(w)
    const all = shots.map((s) => s.hash)
    expect((await svc.cards(all)).map((c) => c.hash)).toEqual(all.slice(0, 200))
    expect((await svc.cards(['shot-001', 'shot-001', 'has a space', 7 as never, 'shot-000', 'x'.repeat(65)])).map((c) => c.hash)).toEqual(['shot-001', 'shot-000'])
    expect(await svc.cards('shot-001' as never)).toEqual([])
  })

  it('reads only: no proposal, decision or answer changes', async () => {
    const w = well()
    const before = proposalsOf(w)
    const decisions = countRows(w, 'triage_decisions')
    await service(w).cards(['sure-toss', 'sure-keep', 'binned'])
    expect(proposalsOf(w)).toEqual(before)
    expect(countRows(w, 'triage_decisions')).toBe(decisions)
  })
})

describe('IPC: review overview and cards', () => {
  const sender = { id: 1 }
  const call = (channel: string, ...args: unknown[]): unknown => ipc.get(channel)!({ sender }, ...args)
  let calls: Array<[string, unknown]>

  beforeEach(() => {
    ipc.clear()
    calls = []
    const svc = {
      overview: (o: unknown) => (calls.push(['overview', o]), 'overview'),
      cards: (h: unknown) => (calls.push(['cards', h]), 'cards')
    }
    registerReviewIpc(svc as never, (s) => s === sender)
  })

  it('answers the main window only', () => {
    for (const ch of ['review:overview', 'review:cards']) expect(() => ipc.get(ch)!({ sender: { id: 2 } }, ['aa']), ch).toThrow(/not allowed from this window/)
    expect(calls).toEqual([])
  })

  it('overview takes nothing, or the known options of the right type and size', () => {
    call('review:overview')
    call('review:overview', {})
    call('review:overview', { queue: 0, sample: 500, order: 'teach' })
    call('review:overview', { order: 'newest' })
    call('review:overview', Object.assign(Object.create(null), { queue: 50 }))
    expect(calls).toEqual([
      ['overview', {}],
      ['overview', { queue: undefined, sample: undefined, order: undefined }],
      ['overview', { queue: 0, sample: 500, order: 'teach' }],
      ['overview', { queue: undefined, sample: undefined, order: 'newest' }],
      ['overview', { queue: 50, sample: undefined, order: undefined }]
    ])
  })

  it('overview refuses anything else', () => {
    const bads: unknown[][] = [
      [null], ['teach'], [7], [true], [[]], [[{ queue: 1 }]], [new Date(0)], [new Map()],
      [{ queue: -1 }], [{ queue: 501 }], [{ queue: 2.5 }], [{ queue: '50' }], [{ queue: Number.NaN }], [{ queue: Infinity }], [{ queue: null }],
      [{ sample: -1 }], [{ sample: 1e9 }], [{ sample: '12' }],
      [{ order: 'oldest' }], [{ order: 1 }], [{ order: null }],
      [{ queue: 10, limit: 10 }], [{ kept: 10 }], [{ __proto__: null, queue: 10, constructor: 'x' }],
      [{}, {}], [{ queue: 10 }, 'more'], [undefined, undefined]
    ]
    for (const bad of bads) expect(() => call('review:overview', ...bad), JSON.stringify(bad)).toThrow('review:overview: bad arguments')
    expect(calls).toEqual([])
  })

  it('cards takes one list of at most 200 hashes and refuses anything else', () => {
    const many = Array.from({ length: 200 }, (_, i) => `h${i}`)
    expect(call('review:cards', ['aa', 'p:0123abc'])).toBe('cards')
    call('review:cards', [])
    call('review:cards', many)
    expect(calls).toEqual([['cards', ['aa', 'p:0123abc']], ['cards', []], ['cards', many]])
    const bads: unknown[][] = [[], [undefined], [null], ['aa'], [{ 0: 'aa', length: 1 }], [[...many, 'one-more']], [['aa', 7]], [['aa', null]], [['has a space']], [['']], [['a'.repeat(65)]], [['../etc']], [[['aa']]], [['aa'], ['bb']], [['aa'], undefined]]
    for (const bad of bads) expect(() => call('review:cards', ...bad), JSON.stringify(bad).slice(0, 60)).toThrow('review:cards: bad arguments')
    expect(calls).toHaveLength(3)
  })
})
