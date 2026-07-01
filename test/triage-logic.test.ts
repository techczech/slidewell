import { describe, it, expect } from 'vitest'
import { tallyTriageStates, planSelectedImport } from '../src/main/triage-logic'

describe('tallyTriageStates', () => {
  it('buckets every state and sums total (selected is NOT folded into undecided)', () => {
    const out = tallyTriageStates([
      { state: 'undecided', n: 4 },
      { state: 'selected', n: 3 },
      { state: 'included', n: 2 },
      { state: 'excluded', n: 1 }
    ])
    expect(out).toEqual({ undecided: 4, selected: 3, included: 2, excluded: 1, total: 10 })
  })
  it('treats an unknown/NULL state as undecided', () => {
    const out = tallyTriageStates([
      { state: 'undecided', n: 5 },
      { state: 'banana', n: 2 },
      { state: null as unknown as string, n: 1 }
    ])
    expect(out.undecided).toBe(8) // 5 known undecided + 2 unknown + 1 null
    expect(out.selected).toBe(0)
    expect(out.total).toBe(8)
  })
})

describe('planSelectedImport', () => {
  const gate = 20 * 1024 * 1024
  it('imports normal images, skips offline and missing, gates large videos not forced', () => {
    const r = planSelectedImport(
      [
        { hash: 'a', kind: 'image', offline: false, missing: false, sizeBytes: 1000 },
        { hash: 'b', kind: 'image', offline: true, missing: false, sizeBytes: 1000 },
        { hash: 'c', kind: 'image', offline: false, missing: true, sizeBytes: 1000 },
        { hash: 'd', kind: 'video', offline: false, missing: false, sizeBytes: gate + 1 }
      ],
      [],
      gate
    )
    expect(r.toImport).toEqual(['a'])
    expect(r.skipped).toEqual([{ hash: 'b', reason: 'offline' }, { hash: 'c', reason: 'missing' }])
    expect(r.gated).toEqual(['d'])
  })
  it('imports a large video when its hash is forced', () => {
    const r = planSelectedImport(
      [{ hash: 'd', kind: 'video', offline: false, missing: false, sizeBytes: gate + 1 }],
      ['d'],
      gate
    )
    expect(r.toImport).toEqual(['d'])
    expect(r.gated).toEqual([])
  })
  it('imports a small video without forcing', () => {
    const r = planSelectedImport(
      [{ hash: 'e', kind: 'video', offline: false, missing: false, sizeBytes: 1000 }],
      [],
      gate
    )
    expect(r.toImport).toEqual(['e'])
  })
  it('classifies offline+missing as missing (missing is checked first)', () => {
    const r = planSelectedImport(
      [{ hash: 'f', kind: 'image', offline: true, missing: true, sizeBytes: 500 }],
      [],
      gate
    )
    expect(r.skipped).toEqual([{ hash: 'f', reason: 'missing' }])
    expect(r.toImport).toEqual([])
    expect(r.gated).toEqual([])
  })
  it('imports a video at exactly the gate boundary (gate is strict >)', () => {
    const r = planSelectedImport(
      [{ hash: 'g', kind: 'video', offline: false, missing: false, sizeBytes: gate }],
      [],
      gate
    )
    expect(r.toImport).toEqual(['g'])
    expect(r.gated).toEqual([])
  })
})
