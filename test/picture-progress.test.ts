import { describe, it, expect } from 'vitest'
import { planQueue, RateMeter, formatEta, statusText, estimateText, coveragePercent } from '../src/main/picture-search/progress'
import { Indexer, type IndexerDeps } from '../src/main/picture-search/indexer'
import type { Fingerprint, IndexItem } from '../src/main/picture-search/vector-store'

const slide = (n: number, mtimeMs = 1): IndexItem => ({ id: `slide:P#${n}`, kind: 'slide', path: `/Volumes/Data/s${n}.webp`, size: 100, mtimeMs })
const well = (id: string): IndexItem => ({ id: `well:${id}`, kind: 'well-image', path: `/Volumes/Data/${id}.webp`, size: 50, mtimeMs: 1 })

describe('planQueue (resume from the store)', () => {
  it('skips what the store already holds, re-embeds changed files, puts well images first', () => {
    const items = [slide(1), slide(2), slide(3, 99), well('aa'), slide(1)]
    const handled = new Map<string, Fingerprint>([
      ['slide:P#1', { size: 100, mtimeMs: 1 }],
      ['slide:P#3', { size: 100, mtimeMs: 1 }] // file changed since → todo again
    ])
    const plan = planQueue(items, handled)
    expect(plan.total).toBe(4)
    expect(plan.done).toBe(1)
    expect(plan.todo.map((i) => i.id)).toEqual(['well:aa', 'slide:P#2', 'slide:P#3'])
  })
})

describe('progress words', () => {
  it('formats the status line, time left and the Settings estimate', () => {
    expect(statusText({ phase: 'indexing', done: 12480, total: 61661, failed: 0, secondsLeft: 3 * 3600 + 600 })).toBe('picture search: indexing 12,480 / 61,661 · about 3 h left')
    expect(statusText({ phase: 'paused', done: 7, total: 50, failed: 0, secondsLeft: null })).toBe('picture search: paused at 7 / 50')
    expect(statusText({ phase: 'done', done: 50, total: 50, failed: 2, secondsLeft: 0 })).toBe('picture search: 50 indexed · 2 could not be read')
    expect(formatEta(1500)).toBe('about 25 min left')
    expect(formatEta(20)).toBe('less than a minute left')
    expect(estimateText(61661)).toBe('about 4–5 hours')
    expect(estimateText(50)).toBe('under a minute')
    expect(coveragePercent({ done: 12480, total: 61661 })).toBe(20)
  })

  it('RateMeter ignores the warm-up image and averages the rest', () => {
    const m = new RateMeter(3)
    m.add(9)
    expect(m.perItem()).toBeNull()
    ;[0.2, 0.4, 0.3, 0.5].forEach((s) => m.add(s))
    expect(m.perItem()).toBeCloseTo(0.4, 5)
  })
})

/** An indexer over an in-memory "store", with an embed that can be gated to pause mid-run. */
function harness(items: IndexItem[]) {
  const stored = new Map<string, Fingerprint>()
  const failures = new Map<string, Fingerprint>()
  const events: string[] = []
  let gate: (() => void) | null = null
  let holdAt = -1
  let embedded = 0
  let engineDown = false
  const deps: IndexerDeps = {
    enumerate: async () => items,
    handled: () => new Map([...stored, ...failures]),
    failedCount: () => failures.size,
    embed: async (it) => {
      if (engineDown) throw new Error('window crashed')
      if (it.path.includes('broken')) throw Object.assign(new Error('cannot read image'), { item: true })
      if (embedded === holdAt) await new Promise<void>((r) => (gate = r))
      embedded++
      stored.set(it.id, { size: it.size, mtimeMs: it.mtimeMs })
    },
    isItemFailure: (e) => Boolean((e as { item?: boolean }).item),
    recordFailure: (it) => failures.set(it.id, { size: it.size, mtimeMs: it.mtimeMs }),
    onProgress: (p) => events.push(`${p.phase} ${p.done}/${p.total}`),
    progressEveryMs: 0
  }
  return { deps, stored, failures, events, holdAfter: (n: number) => (holdAt = n), release: () => gate?.(), setEngineDown: (v: boolean) => (engineDown = v) }
}

describe('Indexer (pause, restart, resume, new arrivals)', () => {
  it('pauses mid-run, and a fresh indexer over the same store resumes where it stopped', async () => {
    const items = Array.from({ length: 10 }, (_, i) => slide(i + 1))
    const h = harness(items)
    h.holdAfter(4)
    const a = new Indexer(h.deps)
    const run = a.start()
    await new Promise((r) => setTimeout(r, 10))
    const paused = a.pause()
    h.release()
    await paused
    await run
    expect(a.state().phase).toBe('paused')
    expect(h.stored.size).toBe(5) // the image in flight finished, nothing after it
    // "restart": a new indexer, same store
    const b = new Indexer(h.deps)
    await b.start()
    expect(h.stored.size).toBe(10)
    expect(b.state()).toMatchObject({ phase: 'done', done: 10, total: 10 })
    expect(h.events).toContain('indexing 5/10')
  })

  it('records unreadable images and goes on; an engine failure stops without recording', async () => {
    const h = harness([slide(1), { ...slide(2), path: '/Volumes/Data/broken.webp' }, slide(3)])
    const ix = new Indexer(h.deps)
    await ix.start()
    expect(h.failures.size).toBe(1)
    expect(ix.state()).toMatchObject({ phase: 'done', done: 3, failed: 1 })

    const h2 = harness([slide(1), slide(2)])
    h2.setEngineDown(true)
    const ix2 = new Indexer(h2.deps)
    await ix2.start()
    expect(ix2.state().phase).toBe('error')
    expect(h2.failures.size).toBe(0)
    h2.setEngineDown(false)
    await ix2.start()
    expect(ix2.state()).toMatchObject({ phase: 'done', done: 2 })
  })

  it('poke embeds images that arrived after a finished pass; not while paused', async () => {
    const items: IndexItem[] = [slide(1)]
    const h = harness(items)
    const ix = new Indexer(h.deps)
    await ix.start()
    items.push(well('new1'))
    ix.poke()
    await new Promise((r) => setTimeout(r, 20))
    expect(h.stored.has('well:new1')).toBe(true)
    await ix.pause()
    items.push(well('new2'))
    ix.poke()
    await new Promise((r) => setTimeout(r, 20))
    expect(h.stored.has('well:new2')).toBe(false)
    expect(ix.state()).toMatchObject({ phase: 'paused', done: 2, total: 3 })
  })
})
