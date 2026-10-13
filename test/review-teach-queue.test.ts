import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { ReviewService } from '../src/main/review/service'
import { shownReason } from '../src/main/review/store'
import { compareKeys, teachKey } from '../src/main/review/piles'
import { SorterStore } from '../src/main/sorter/store'
import { SORTER_VERSION } from '../src/main/sorter/decide'
import { addShots, seedProposals, teachWell } from './sorter-teach-fixture'

const wells: string[] = []
afterEach(() => {
  for (const w of wells.splice(0)) rmSync(w, { recursive: true, force: true })
})

const NOW = Date.parse('2026-10-13T10:00:00Z')

/** Undecided screenshots with a proposal each; p(keep) and capture time as given. */
function well(shots: Array<{ hash: string; pKeep: number; takenAt: string; proposal?: 'keep' | 'throwaway' | 'doubtful'; version?: string; app?: string; reason?: string; answeredAt?: string }>): string {
  const w = teachWell(0, 0, shots.map((s) => ({ hash: s.hash, takenAt: s.takenAt, app: s.app })))
  wells.push(w)
  new SorterStore(w).close()
  seedProposals(w, shots.map((s) => ({ hash: s.hash, pKeep: s.pKeep, proposal: s.proposal, sorterVersion: s.version ?? SORTER_VERSION, reason: s.reason, answeredAt: s.answeredAt })))
  return w
}

const review = (w: string, why?: ConstructorParameters<typeof ReviewService>[0]['why']): ReviewService =>
  new ReviewService({ wellRoot: () => w, archiveRoot: () => join(w, 'archive'), sourceRoot: () => null, thumbUrl: (abs) => (abs ? `swthumb://t/${abs.split('/').pop()}` : null), now: () => NOW, why })

describe('the teaching order', () => {
  it('least sure first: distance of p(keep) from 0.5, then newest, then hash', () => {
    const k = (p: number, t: number, h: string) => teachKey(p, t, h)
    expect(compareKeys(k(0.52, 1, 'a'), k(0.4, 9, 'b'))).toBeLessThan(0)
    expect(compareKeys(k(0.38, 1, 'a'), k(0.62, 9, 'b'))).toBeGreaterThan(0) // equally unsure: the newer one first
    expect(compareKeys(k(0.5, 5, 'a'), k(0.5, 5, 'b'))).toBeLessThan(0)
    expect(teachKey(Number.NaN, 0, 'x')[0]).toBe(0)
  })
})

describe('teach queue', () => {
  const shots = [
    { hash: 'far-keep', pKeep: 0.68, takenAt: '2026-10-12T09:00:00' },
    { hash: 'even-old', pKeep: 0.5, takenAt: '2026-10-01T09:00:00' },
    { hash: 'even-new', pKeep: 0.5, takenAt: '2026-10-11T09:00:00' },
    { hash: 'lean-toss', pKeep: 0.38, takenAt: '2026-10-05T09:00:00' },
    { hash: 'lean-keep', pKeep: 0.62, takenAt: '2026-10-09T09:00:00' },
    { hash: 'far-toss', pKeep: 0.2, takenAt: '2026-10-12T10:00:00' }
  ]

  it('lists what the sorter is least sure of first, newest first when equally unsure', async () => {
    const q = await review(well(shots)).teachQueue()
    expect(q.total).toBe(6)
    expect(q.next).toBeNull()
    expect(q.items.map((c) => c.hash)).toEqual(['even-new', 'even-old', 'lean-keep', 'lean-toss', 'far-keep', 'far-toss'])
    expect(q.items[2]).toMatchObject({ hash: 'lean-keep', pKeep: 0.62, leans: 'keep', proposal: 'doubtful', pile: 'doubtful', thumbUrl: 'swthumb://t/lean-keep.png' })
    expect(q.items[3]).toMatchObject({ pKeep: 0.38, leans: 'throwaway' })
    expect(q.items[0].why).toBe(q.items[0].reason) // nothing supplies a plainer reason here
  })

  it('pages without repeating or skipping', async () => {
    const svc = review(well(shots))
    const first = await svc.teachQueue(null, 4)
    expect(first.items.map((c) => c.hash)).toEqual(['even-new', 'even-old', 'lean-keep', 'lean-toss'])
    expect(first.next).not.toBeNull()
    const second = await svc.teachQueue(first.next, 4)
    expect(second.items.map((c) => c.hash)).toEqual(['far-keep', 'far-toss'])
    expect(second).toMatchObject({ total: 6, next: null })
  })

  it('holds only undecided screenshots with a doubtful proposal made by the current sorter', async () => {
    const w = well([
      ...shots,
      { hash: 'sure-keep', pKeep: 0.9, takenAt: '2026-10-12T11:00:00', proposal: 'keep' as const },
      { hash: 'sure-toss', pKeep: 0.05, takenAt: '2026-10-12T11:00:00', proposal: 'throwaway' as const },
      { hash: 'older-sorter', pKeep: 0.5, takenAt: '2026-10-12T11:00:00', version: 'sorter-local-1' },
      { hash: 'answered', pKeep: 0.5, takenAt: '2026-10-12T11:00:00', answeredAt: '2026-10-12T12:00:00.000Z' }
    ])
    addShots(w, [{ hash: 'even-new', state: 'excluded', decidedAt: '2026-10-13T09:00:00.000Z' }]) // he answered it
    const q = await review(w).teachQueue(null, 50)
    expect(q.items.map((c) => c.hash)).toEqual(['even-old', 'lean-keep', 'lean-toss', 'far-keep', 'far-toss'])
  })

  it('carries the plain-words why for each card', async () => {
    const svc = review(well(shots), (items) => new Map(items.map((i) => [i.hash, `why:${i.hash}:${i.app ?? 'no app'}`])))
    const q = await svc.teachQueue(null, 2)
    expect(q.items.map((c) => c.why)).toEqual(['why:even-new:no app', 'why:even-old:no app'])
  })
})

describe('Review: "teaches most first"', () => {
  const shots = [
    { hash: 'aa-old-even', pKeep: 0.5, takenAt: '2026-10-01T09:00:00' },
    { hash: 'bb-new-far', pKeep: 0.31, takenAt: '2026-10-12T09:00:00' },
    { hash: 'cc-mid-near', pKeep: 0.55, takenAt: '2026-10-06T09:00:00' },
    { hash: 'dd-older-sorter', pKeep: 0.52, takenAt: '2026-10-03T09:00:00', version: 'sorter-local-1' }
  ]

  it('the queue is newest first unless the teaching order is asked for', async () => {
    const svc = review(well(shots), (items) => new Map(items.map((i) => [i.hash, 'because']))) 
    expect((await svc.overview()).queue.map((c) => c.hash)).toEqual(['bb-new-far', 'cc-mid-near', 'dd-older-sorter', 'aa-old-even'])
    expect((await svc.overview({ order: 'newest' })).queue.map((c) => c.hash)).toEqual(['bb-new-far', 'cc-mid-near', 'dd-older-sorter', 'aa-old-even'])
    const teach = await svc.overview({ order: 'teach' })
    expect(teach.queue.map((c) => c.hash)).toEqual(['aa-old-even', 'dd-older-sorter', 'cc-mid-near', 'bb-new-far'])
    expect(teach.queue.every((c) => c.why === 'because')).toBe(true)
    expect(teach.needALook).toBe(4)
  })
})

describe('words', () => {
  it('a reason stored before the wording changed is shown as "threw away"', async () => {
    expect(shownReason('Finder window — usually throwaway; looks like screenshots you binned before')).toBe('Finder window — usually throwaway; looks like screenshots you threw away before')
    const w = well([{ hash: 'old-words', pKeep: 0.3, takenAt: '2026-10-12T09:00:00', reason: 'Not sure: it looks like screenshots you binned before, but not sure enough to throw away' }])
    const q = await review(w).teachQueue()
    expect(q.items[0].reason).toBe('Not sure: it looks like screenshots you threw away before, but not sure enough to throw away')
    expect(JSON.stringify(q)).not.toMatch(/binned/)
  })
})
