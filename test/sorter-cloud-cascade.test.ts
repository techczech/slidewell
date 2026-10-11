import { describe, it, expect } from 'vitest'
import { applyLuna, decidedByLocal, type CascadeRow } from '../src/main/sorter/cloud/cascade'
import { decide, DEFAULT_THRESHOLDS } from '../src/main/sorter/decide'

const doubtful: CascadeRow = { proposal: 'doubtful', confidence: 0.6, pKeep: 0.4, reason: 'Not sure: local reason', decidedBy: null }

describe("Luna's answer obeys the keep-bias", () => {
  it('keep becomes keep, whatever its confidence', () => {
    expect(applyLuna(doubtful, { verdict: 'keep', confidence: 0.55, reason: 'A slide-worthy chart.' })).toEqual({ proposal: 'keep', confidence: 0.55, pKeep: 0.55, reason: 'A slide-worthy chart', decidedBy: 'luna' })
  })

  it('throwaway counts only at or above the throwaway threshold', () => {
    const t = DEFAULT_THRESHOLDS.throwaway
    expect(applyLuna(doubtful, { verdict: 'throwaway', confidence: t, reason: 'Wi-Fi settings.' })).toMatchObject({ proposal: 'throwaway', confidence: t, decidedBy: 'luna' })
    const below = applyLuna(doubtful, { verdict: 'throwaway', confidence: t - 0.01, reason: 'Probably a file picker.' })
    expect(below).toMatchObject({ proposal: 'doubtful', confidence: 0.6, pKeep: 0.4, decidedBy: 'luna' })
    expect(below.reason).toBe('Not sure: Luna leans throwaway (89%), not sure enough to throw away: probably a file picker')
  })

  it('unsure stays doubtful, with Luna named in the reason', () => {
    const r = applyLuna(doubtful, { verdict: 'unsure', confidence: 0.95, reason: 'Hard to tell.' })
    expect(r).toMatchObject({ proposal: 'doubtful', decidedBy: 'luna' })
    expect(r.reason).toBe('Not sure, and Luna was not sure either: hard to tell')
  })

  it('a stricter threshold is respected; none below the floor is accepted', () => {
    expect(applyLuna(doubtful, { verdict: 'throwaway', confidence: 0.95, reason: 'x' }, { throwaway: 0.97, keep: 0.7 }).proposal).toBe('doubtful')
    expect(() => applyLuna(doubtful, { verdict: 'throwaway', confidence: 0.95, reason: 'x' }, { throwaway: 0.6, keep: 0.7 })).toThrow(/at least 0.85/)
  })

  it('a confident local proposal is never changed', () => {
    const keep: CascadeRow = { proposal: 'keep', confidence: 0.9, pKeep: 0.9, reason: 'r', decidedBy: 'rules' }
    expect(applyLuna(keep, { verdict: 'throwaway', confidence: 0.99, reason: 'x' })).toBe(keep)
  })
})

describe('which local step made the call', () => {
  const terminal = { lean: 'throwaway' as const, confidence: 0.95, rule: 'terminal', reason: 'Terminal window — usually throwaway' }
  it("'rules' when the rule alone reaches the same proposal; 'your history' otherwise; none for doubtful", () => {
    expect(decidedByLocal(decide(terminal, null), terminal)).toBe('rules')
    expect(decidedByLocal(decide(terminal, 0.05), terminal)).toBe('rules')
    expect(decidedByLocal(decide(null, 0.02), null)).toBe('history')
    const weak = { ...terminal, confidence: 0.7 }
    expect(decidedByLocal(decide(weak, 0.02), weak)).toBe('history') // the rule alone would have been doubtful
    expect(decidedByLocal({ proposal: 'doubtful' }, terminal)).toBeNull()
  })
})
