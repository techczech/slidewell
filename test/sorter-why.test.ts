import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { readAppHistory, whyFromApp, whyFromNeighbours, whyReader, WHY_LAST, type AppHistory, type LabelledVector } from '../src/main/sorter/why'
import { addShots, teachWell, vectorFor, type FixtureShot } from './sorter-teach-fixture'

const wells: string[] = []
afterEach(() => {
  for (const w of wells.splice(0)) rmSync(w, { recursive: true, force: true })
})

const unit = (x: number, y: number): Float32Array => {
  const n = Math.hypot(x, y)
  return new Float32Array([x / n, y / n])
}

describe('why, from the app', () => {
  const history: AppHistory = new Map([
    ['brightloom', [true, false, false, true, false, false, false, false, false, false, false, false, false, true]],
    ['quillpad', [true, true, false, true]],
    ['tallymark', Array.from({ length: 30 }, (_, i) => i < 5)]
  ])

  it('says how many of his last decisions from the app were keeps', () => {
    expect(whyFromApp('Brightloom', history)).toBe('You kept 3 of the last 14 from Brightloom')
    expect(whyFromApp('  brightloom ', history)).toBe('You kept 3 of the last 14 from brightloom')
  })

  it('looks at no more than the last twenty', () => {
    expect(WHY_LAST).toBe(20)
    expect(whyFromApp('Tallymark', history)).toBe('You kept 5 of the last 20 from Tallymark')
  })

  it('has nothing to say for an app with fewer than five decisions, or no app', () => {
    expect(whyFromApp('Quillpad', history)).toBeNull()
    expect(whyFromApp('Neverseen', history)).toBeNull()
    expect(whyFromApp('', history)).toBeNull()
    expect(whyFromApp(null, history)).toBeNull()
  })
})

describe('why, from nearby screenshots', () => {
  const labelled: LabelledVector[] = [
    { vector: unit(1, 0.0), keep: false },
    { vector: unit(1, 0.1), keep: false },
    { vector: unit(1, 0.2), keep: false },
    { vector: unit(1, 0.3), keep: true },
    { vector: unit(1, 0.4), keep: false },
    { vector: unit(0, 1), keep: true },
    { vector: unit(0.1, 1), keep: true },
    { vector: unit(0.2, 1), keep: true },
    { vector: unit(0.3, 1), keep: true }
  ]

  it('counts the five nearest of his choices, whichever way most went', () => {
    expect(whyFromNeighbours(unit(1, 0.05), labelled)).toBe('Looks like 4 of 5 nearby screenshots you threw away')
    expect(whyFromNeighbours(unit(0.05, 1), labelled)).toBe('Looks like 4 of 5 nearby screenshots you kept')
  })

  it('needs the picture embedded and at least five choices to compare with', () => {
    expect(whyFromNeighbours(undefined, labelled)).toBeNull()
    expect(whyFromNeighbours(unit(1, 0), labelled.slice(0, 4))).toBeNull()
    expect(whyFromNeighbours(new Float32Array([1, 0, 0]), labelled)).toBeNull() // another model's embedding
  })
})

describe('why, read from the well', () => {
  const day = (d: number): string => `2026-10-${String(d).padStart(2, '0')}T09:00:00.000Z`
  function well(): string {
    const brightloom: FixtureShot[] = Array.from({ length: 7 }, (_, i) => ({ hash: `bl-${i}-${i < 2 ? 'keep' : 'toss'}`, state: i < 2 ? ('included' as const) : ('excluded' as const), app: 'Brightloom', decidedAt: day(i + 1) }))
    const w = teachWell(6, 6, [
      ...brightloom,
      { hash: 'staged-keep', state: 'selected', app: 'Quillpad', decidedAt: day(9) },
      { hash: 'ask-brightloom', app: 'Brightloom' },
      { hash: 'ask-toss-like', app: 'Quillpad' },
      { hash: 'ask-keep-like' },
      { hash: 'ask-not-embedded' }
    ])
    wells.push(w)
    return w
  }
  // a clean embedding: kept-looking and thrown-away-looking pictures far apart, a little spread within each
  const clean = (id: string): Float32Array => {
    const jitter = (vectorFor(id)[5] + 1) / 20
    const v = [id.includes('keep') ? 1 : jitter, id.includes('toss') ? 1 : jitter, jitter]
    const n = Math.hypot(...v)
    return new Float32Array(v.map((x) => x / n))
  }
  const stored = (missing: string[] = []) => (ids: string[]): Map<string, Float32Array> => new Map(ids.filter((id) => !missing.some((m) => id.includes(m))).map((id) => [id, clean(id)]))

  it('reads his decisions per app, newest first, a staged keep included', () => {
    const { history } = readAppHistory(well())
    expect(history.get('brightloom')).toEqual([false, false, false, false, false, true, true])
    expect(history.get('quillpad')).toEqual([true])
  })

  it('app first, then neighbours, then the sorter\'s own reason', () => {
    const w = well()
    const why = whyReader({ wellRoot: () => w, storedVectors: stored(['ask-not-embedded']) })
    const out = why([
      { hash: 'ask-brightloom', app: 'Brightloom', reason: 'r1' },
      { hash: 'ask-toss-like', app: 'Quillpad', reason: 'r2' },
      { hash: 'ask-keep-like', app: null, reason: 'r3' },
      { hash: 'ask-not-embedded', app: null, reason: 'Not sure: no rule fits and there is nothing learnt to compare it with' }
    ])
    expect(out.get('ask-brightloom')).toBe('You kept 2 of the last 7 from Brightloom')
    expect(out.get('ask-toss-like')).toBe('Looks like 5 of 5 nearby screenshots you threw away')
    expect(out.get('ask-keep-like')).toBe('Looks like 5 of 5 nearby screenshots you kept')
    expect(out.get('ask-not-embedded')).toBe('Not sure: no rule fits and there is nothing learnt to compare it with')
  })

  it('with no embeddings stored for his choices, falls back to the reason', () => {
    const w = well()
    const why = whyReader({ wellRoot: () => w, storedVectors: () => new Map() })
    expect(why([{ hash: 'ask-keep-like', app: null, reason: 'r3' }]).get('ask-keep-like')).toBe('r3')
  })

  it('follows a new decision, and survives a store that cannot be read', () => {
    const w = well()
    let reads = 0
    const base = stored()
    const why = whyReader({ wellRoot: () => w, storedVectors: (ids) => (reads++, base(ids)) })
    const ask = [{ hash: 'ask-keep-like', app: 'Quillpad', reason: 'r' }]
    why(ask)
    why(ask)
    expect(reads).toBe(3) // his choices once, the asked picture each time
    addShots(w, Array.from({ length: 5 }, (_, i) => ({ hash: `qp-${i}-keep`, state: 'included' as const, app: 'Quillpad', decidedAt: day(20 + i) })))
    expect(why(ask).get('ask-keep-like')).toBe('You kept 6 of the last 6 from Quillpad')
    const broken = whyReader({ wellRoot: () => w, storedVectors: () => { throw new Error('index unreadable') } })
    expect(broken([{ hash: 'ask-keep-like', app: null, reason: 'r3' }]).get('ask-keep-like')).toBe('r3')
  })
})
