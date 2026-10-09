import { describe, it, expect } from 'vitest'
import { accuracyReport, holdOutSplit, type LabelledPrediction } from '../src/main/sorter/accuracy'

const rows = (truth: 'keep' | 'throwaway', proposal: LabelledPrediction['proposal'], n: number): LabelledPrediction[] => Array.from({ length: n }, () => ({ truth, proposal }))

describe('accuracy report', () => {
  it('keep precision, throwaway precision, share doubtful and the costly error', () => {
    const r = accuracyReport([...rows('keep', 'keep', 18), ...rows('throwaway', 'keep', 2), ...rows('throwaway', 'throwaway', 9), ...rows('keep', 'throwaway', 1), ...rows('keep', 'doubtful', 6), ...rows('throwaway', 'doubtful', 4)])
    expect(r.sample).toBe(40)
    expect(r.truth).toEqual({ keep: 25, throwaway: 15 })
    expect(r.keep).toEqual({ proposed: 20, correct: 18, precision: 0.9 })
    expect(r.throwaway).toEqual({ proposed: 10, correct: 9, precision: 0.9 })
    expect(r.doubtful).toEqual({ count: 10, share: 0.25 })
    expect(r.keptProposedThrowaway).toBe(1)
    expect(r.binnedProposedKeep).toBe(2)
  })

  it('precision is null when nothing was proposed with that label; empty input is safe', () => {
    const r = accuracyReport(rows('keep', 'doubtful', 3))
    expect(r.keep.precision).toBeNull()
    expect(r.throwaway.precision).toBeNull()
    expect(r.doubtful.share).toBe(1)
    expect(accuracyReport([]).doubtful.share).toBe(0)
  })
})

describe('hold-out split', () => {
  const items = [...Array.from({ length: 50 }, (_, i) => ({ id: `k${i}`, label: 'keep' })), ...Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, label: 'throwaway' }))]
  const split = (xs: typeof items): ReturnType<typeof holdOutSplit<(typeof items)[number]>> =>
    holdOutSplit(
      xs,
      (x) => x.id,
      (x) => x.label,
      0.2
    )

  it('holds back 20% of each label, disjoint from training', () => {
    const { train, test } = split(items)
    expect(test.filter((x) => x.label === 'keep')).toHaveLength(10)
    expect(test.filter((x) => x.label === 'throwaway')).toHaveLength(3)
    expect(train.length + test.length).toBe(items.length)
    const ids = new Set(train.map((x) => x.id))
    expect(test.some((x) => ids.has(x.id))).toBe(false)
  })

  it('is stable: the same history in another order gives the same sample', () => {
    const a = split(items).test.map((x) => x.id).sort()
    const b = split([...items].reverse()).test.map((x) => x.id).sort()
    expect(b).toEqual(a)
  })
})
