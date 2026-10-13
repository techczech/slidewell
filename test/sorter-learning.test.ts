import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { curveSteps, HELPING, LearningCurve, learningVerdict, nestedOrder, storedLearning } from '../src/main/sorter/learning'
import type { SorterLearning, SorterLearningPoint } from '../src/preload'
import { fakePictures, teachWell } from './sorter-teach-fixture'

const wells: string[] = []
afterEach(() => {
  for (const w of wells.splice(0)) rmSync(w, { recursive: true, force: true })
})

const curve = (rows: Array<[number, number | null, number | null]>): SorterLearningPoint[] => rows.map(([choices, throwawayRight, needALook]) => ({ choices, throwawayRight, needALook }))

describe('learning curve: the steps', () => {
  it('at most six evenly spaced sizes, the last one all his choices', () => {
    expect(curveSteps(312)).toEqual([52, 104, 156, 208, 260, 312])
    expect(curveSteps(2000)).toEqual([333, 667, 1000, 1333, 1667, 2000])
    expect(curveSteps(100)).toEqual([50, 100])
    expect(curveSteps(70)).toEqual([70])
    expect(curveSteps(0)).toEqual([])
  })

  it('every leading part of the order has about his mix of kept and thrown away, whatever order they came in', () => {
    const items = [...Array.from({ length: 60 }, (_, i) => ({ key: `k${i}`, keep: true })), ...Array.from({ length: 20 }, (_, i) => ({ key: `t${i}`, keep: false }))]
    const order = nestedOrder(items, (x) => x.key, (x) => x.keep)
    expect(order).toHaveLength(80)
    for (const n of [8, 20, 40, 64]) {
      const thrown = order.slice(0, n).filter((x) => !x.keep).length
      expect(Math.abs(thrown - n / 4), `first ${n}`).toBeLessThanOrEqual(1)
    }
    expect(nestedOrder([...items].reverse(), (x) => x.key, (x) => x.keep)).toEqual(order)
  })
})

describe('learning curve: the verdict', () => {
  it('still helping while the last two steps still gain', () => {
    // the drawn curve: throwaway right 74 → 91, needing a look 46 → 13.5
    const drawn = curve([[50, 0.74, 0.46], [100, 0.83, 0.34], [150, 0.87, 0.25], [200, 0.895, 0.19], [250, 0.905, 0.16], [312, 0.91, 0.135]])
    expect(learningVerdict(drawn, 0)).toBe('still-helping')
    // accuracy flat, but far fewer need a look
    expect(learningVerdict(curve([[100, 0.9, 0.4], [200, 0.9, 0.3], [300, 0.9, 0.2]]), 0)).toBe('still-helping')
    // the queue no shorter, but throwaway right still rising
    expect(learningVerdict(curve([[100, 0.8, 0.2], [200, 0.85, 0.2], [300, 0.9, 0.2]]), 0)).toBe('still-helping')
  })

  it('levelling off when neither moves by more than the noise', () => {
    expect(learningVerdict(curve([[200, 0.7, 0.4], [400, 0.9, 0.15], [600, 0.905, 0.145], [800, 0.91, 0.14]]), 0)).toBe('levelling-off')
    expect(learningVerdict(curve([[400, 0.92, 0.12], [600, 0.9, 0.13], [800, 0.91, 0.125]]), 0)).toBe('levelling-off') // slightly worse is not a gain
  })

  it('the thresholds are per hundred further choices, over the last two steps', () => {
    const at = (needALook: number, right: number): SorterLearningPoint[] => curve([[100, 0.5, 0.9], [200, 0.8, 0.3], [300, 0.8, 0.3], [400, right, needALook]])
    expect(HELPING).toEqual({ throwawayRightPer100: 0.01, needALookPer100: 0.02 })
    expect(learningVerdict(at(0.3 - 0.041, 0.8), 0)).toBe('still-helping') // 2 points per 100 over 200 choices
    expect(learningVerdict(at(0.3 - 0.039, 0.8), 0)).toBe('levelling-off')
    expect(learningVerdict(at(0.3, 0.821), 0)).toBe('still-helping') // 1 point per 100
    expect(learningVerdict(at(0.3, 0.819), 0)).toBe('levelling-off')
  })

  it('not enough while a training cannot be measured; with one measured point there is no slope yet', () => {
    expect(learningVerdict([], 26)).toBe('not-enough')
    expect(learningVerdict(curve([[50, 0.9, 0.2], [100, 0.9, 0.2], [150, 0.9, 0.2]]), 4)).toBe('not-enough')
    expect(learningVerdict(curve([[50, null, null], [100, 0.9, 0.2]]), 0)).toBe('still-helping')
    expect(learningVerdict([], 0)).toBe('still-helping')
    // a size that could not be trained is skipped; throwaway right missing at one end: the queue alone decides
    expect(learningVerdict(curve([[100, null, null], [200, null, 0.3], [300, 0.9, 0.3]]), 0)).toBe('levelling-off')
  })
})

describe('learning curve: the reading', () => {
  function rig(kept: number, thrown: number) {
    const w = teachWell(kept, thrown)
    wells.push(w)
    const pictures = fakePictures()
    const s = { training: { id: 't1', trainedAt: '2026-10-13T09:00:00.000Z' } as { id: string; trainedAt: string } | null, stored: undefined as unknown, saves: 0, ready: true }
    const make = (): LearningCurve =>
      new LearningCurve({
        wellRoot: () => w,
        pictures: { modelReady: () => s.ready, ensureVectors: pictures.ensureVectors },
        training: () => s.training,
        stored: () => s.stored,
        save: (r) => {
          s.stored = JSON.parse(JSON.stringify(r))
          s.saves++
        }
      })
    return { s, pictures, make, curve: make() }
  }

  it('trains on growing parts and tests each on the same held-back sample', async () => {
    const t = rig(140, 60)
    const l = await t.curve.read()
    expect(l).toMatchObject({ minimum: 92, more: 0, choices: 200, kept: 140, thrownAway: 60, heldBack: 40, trainedAt: '2026-10-13T09:00:00.000Z' })
    expect(l.error).toBeUndefined()
    expect(l.points.map((p) => p.choices)).toEqual([50, 100, 150, 200])
    for (const p of l.points) {
      expect(p.needALook).toBeGreaterThanOrEqual(0)
      expect(p.needALook).toBeLessThanOrEqual(1)
    }
    expect(['still-helping', 'levelling-off']).toContain(l.verdict)
    expect(l.points[l.points.length - 1].throwawayRight).toBeGreaterThan(0.8) // this history is easy to tell apart
  }, 30_000)

  it('is computed once per training: kept in memory, stored, and read back after a restart', async () => {
    const t = rig(70, 30)
    const [a, b] = await Promise.all([t.curve.read(), t.curve.read()]) // asked twice while computing: one computation
    expect(b).toBe(a)
    const embedded = t.pictures.calls.n
    expect(embedded).toBe(100)
    expect(await t.curve.read()).toBe(a)
    expect(t.pictures.calls.n).toBe(embedded)
    expect(t.s.saves).toBe(1)
    expect(await t.make().read()).toEqual(a) // a new process: from config
    expect(t.pictures.calls.n).toBe(embedded)
    t.s.training = { id: 't2', trainedAt: '2026-10-13T11:00:00.000Z' } // he retrained
    const next = await t.curve.read()
    expect(next.trainedAt).toBe('2026-10-13T11:00:00.000Z')
    expect(t.pictures.calls.n).toBe(embedded * 2)
    expect(t.s.saves).toBe(2)
  }, 30_000)

  it('too few choices: says how many more, trains nothing and stores nothing', async () => {
    const t = rig(50, 20)
    const l = await t.curve.read()
    expect(l).toMatchObject({ verdict: 'not-enough', more: 26, choices: 70, kept: 50, thrownAway: 20, points: [], heldBack: 0 })
    expect(t.pictures.calls.n).toBe(0)
    expect(t.s.saves).toBe(0)
  })

  it('without the picture model there is an error, not a curve, and it is tried again next time', async () => {
    const t = rig(70, 30)
    t.s.ready = false
    const l = await t.curve.read()
    expect(l.points).toEqual([])
    expect(l.error).toMatch(/picture search model/)
    expect(t.s.saves).toBe(0)
    t.s.ready = true
    expect((await t.curve.read()).points.length).toBe(2)
  }, 30_000)

  it('reads back only a whole stored reading for the same training', () => {
    const good: SorterLearning = { verdict: 'levelling-off', more: 0, minimum: 92, choices: 312, kept: 228, thrownAway: 84, heldBack: 60, points: curve([[156, 0.87, 0.25], [312, 0.91, 0.135]]), trainedAt: '2026-10-13T09:00:00.000Z' }
    expect(storedLearning({ key: 't1', learning: good }, 't1')).toEqual(good)
    expect(storedLearning({ key: 't1', learning: good }, 't2')).toBeNull()
    for (const bad of [null, 'x', { key: 't1' }, { key: 't1', learning: { ...good, verdict: 'plenty' } }, { key: 't1', learning: { ...good, points: [{ choices: 10, throwawayRight: 2, needALook: 0 }] } }, { key: 't1', learning: { ...good, choices: -1 } }, { key: 't1', learning: { ...good, error: 'cancelled' } }]) {
      expect(storedLearning(bad, 't1'), JSON.stringify(bad).slice(0, 50)).toBeNull()
    }
  })

  it('reads a stored reading strictly and copies out only its own fields', () => {
    const good: SorterLearning = { verdict: 'still-helping', more: 0, minimum: 92, choices: 312, kept: 228, thrownAway: 84, heldBack: 60, points: curve([[156, 0.87, 0.25], [312, 0.91, 0.135]]), trainedAt: '2026-10-13T09:00:00.000Z' }
    const point = good.points[0]
    const bads: unknown[] = [
      { ...good, points: [{ ...point, choices: Infinity }] },
      { ...good, points: [{ ...point, choices: 156.5 }] },
      { ...good, points: [{ ...point, choices: '156' }] },
      { ...good, points: [{ ...point, needALook: Number.NaN }] },
      { ...good, points: [{ ...point, throwawayRight: -0.1 }] },
      { ...good, points: [point, null] },
      { ...good, points: Array(7).fill(point) },
      { ...good, trainedAt: 'not a date' },
      { ...good, trainedAt: 1760349600000 },
      { ...good, heldBack: Infinity },
      { ...good, kept: 228.4 },
      { ...good, minimum: undefined },
      [good]
    ]
    for (const bad of bads) expect(storedLearning({ key: 't1', learning: bad }, 't1'), JSON.stringify(bad).slice(0, 80)).toBeNull()
    // 1e400 in stored JSON reads as Infinity
    expect(storedLearning(JSON.parse(JSON.stringify({ key: 't1', learning: good }).replace('"choices":156', '"choices":1e400')), 't1')).toBeNull()
    expect(storedLearning({ key: 't1', learning: { ...good, trainedAt: null } }, 't1')).toEqual({ ...good, trainedAt: null })
    const big = 'x'.repeat(1_000_000)
    const stored = { key: 't1', extra: big, learning: { ...good, extra: big, points: good.points.map((p) => ({ ...p, extra: big })) } }
    const read = storedLearning(stored, 't1')
    expect(read).toEqual(good)
    expect(JSON.stringify(read).length).toBeLessThan(600)
    expect(read).not.toBe(stored.learning)
  })
})
