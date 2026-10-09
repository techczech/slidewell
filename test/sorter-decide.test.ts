import { describe, it, expect } from 'vitest'
import { decide, checkThresholds, DEFAULT_THRESHOLDS, THROWAWAY_FLOOR } from '../src/main/sorter/decide'
import { applyRules, type RuleVerdict } from '../src/main/sorter/rules'

const rule = (lean: RuleVerdict['lean'], confidence: number, reason = lean === 'keep' ? 'Looks like a chart — usually kept' : 'Terminal window — usually throwaway'): RuleVerdict => ({
  lean,
  confidence,
  reason,
  rule: 'test'
})

describe('sorter verdict: keep-bias', () => {
  it('no screenshot is labelled throwaway below the throwaway threshold (sweep over rules × classifier)', () => {
    const rules: Array<RuleVerdict | null> = [null]
    for (const c of [0.55, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99]) rules.push(rule('keep', c), rule('throwaway', c))
    const thresholds = [DEFAULT_THRESHOLDS, { throwaway: THROWAWAY_FLOOR, keep: 0.6 }, { throwaway: 0.97, keep: 0.8 }]
    let throwaways = 0
    for (const t of thresholds)
      for (const r of rules)
        for (let i = 0; i <= 200; i++) {
          const pKeep = i === 200 ? null : i / 199
          const v = decide(r, pKeep, t)
          if (v.proposal === 'throwaway') {
            throwaways++
            expect(v.confidence).toBeGreaterThanOrEqual(t.throwaway)
            expect(1 - v.pKeep).toBeGreaterThanOrEqual(t.throwaway)
          }
          if (v.proposal === 'keep') expect(v.pKeep).toBeGreaterThanOrEqual(t.keep)
        }
    expect(throwaways).toBeGreaterThan(0) // the sweep did reach the throwaway band
  })

  it('the doubtful band is not empty: in-between pictures go to review', () => {
    expect(decide(null, 0.5).proposal).toBe('doubtful')
    expect(decide(null, 0.2).proposal).toBe('doubtful') // leans throwaway, not sure enough
    expect(decide(rule('throwaway', 0.8), null).proposal).toBe('doubtful') // a rule alone needs high confidence
  })

  it('a rule decides alone only at high confidence', () => {
    expect(decide(rule('throwaway', 0.9), null).proposal).toBe('throwaway')
    expect(decide(rule('keep', 0.7), null).proposal).toBe('keep')
    expect(decide(null, null).proposal).toBe('doubtful')
  })

  it('a confident classifier that says keep overrides a throwaway rule', () => {
    expect(decide(rule('throwaway', 0.9), 0.8).proposal).not.toBe('throwaway')
  })

  it('thresholds below the floor are refused', () => {
    expect(() => checkThresholds({ throwaway: 0.6, keep: 0.7 })).toThrow()
    expect(() => decide(null, 0.01, { throwaway: 0.5, keep: 0.7 })).toThrow()
    expect(() => checkThresholds({ throwaway: 0.9, keep: 0.4 })).toThrow()
  })
})

describe('sorter verdict: reasons in plain words', () => {
  it('uses the rule reason for a confident throwaway', () => {
    const r = applyRules({ app: 'Terminal', ocrText: 'git push rejected error: failed to push some refs' })
    const v = decide(r, 0.2)
    expect(v.proposal).toBe('throwaway')
    expect(v.reason).toMatch(/^Terminal window with a short error — usually throwaway/)
  })

  it('says what it learnt when no rule fits', () => {
    expect(decide(null, 0.95).reason).toBe('Looks like screenshots you kept before')
    expect(decide(null, 0.01).reason).toBe('Looks like screenshots you binned before')
  })

  it('doubtful reasons say why it is unsure', () => {
    expect(decide(rule('throwaway', 0.8), 0.7).reason).toBe('Not sure: Terminal window, but it looks like screenshots you kept before')
    expect(decide(null, 0.5).reason).toMatch(/^Not sure/)
    expect(decide(rule('keep', 0.65), 0.3).reason).toBe('Not sure: looks like a chart, but it looks like screenshots you binned before')
  })
})

describe('sorter verdict: copy of a kept screenshot (look-alike signal)', () => {
  it('leans throwaway: the signal raises p(throwaway) for the same inputs, never lowers it', () => {
    for (const p of [0.2, 0.5, 0.8]) {
      const none = decide(null, p)
      const same = decide(null, p, DEFAULT_THRESHOLDS, 'same-picture')
      const changed = decide(null, p, DEFAULT_THRESHOLDS, 'same-thing')
      expect(1 - same.pKeep).toBeGreaterThan(1 - none.pKeep)
      expect(1 - same.pKeep).toBeGreaterThan(1 - changed.pKeep)
      expect(1 - changed.pKeep).toBeGreaterThan(1 - none.pKeep)
    }
  })
  it('turns a borderline doubtful into throwaway only when it reaches the threshold, and says why', () => {
    const base = decide(rule('throwaway', 0.8), 0.4)
    expect(base.proposal).toBe('doubtful')
    const nudged = decide(rule('throwaway', 0.8), 0.4, DEFAULT_THRESHOLDS, 'same-picture')
    expect(nudged.proposal).toBe('throwaway')
    expect(1 - nudged.pKeep).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.throwaway)
    expect(nudged.reason).toMatch(/one you already kept/)
  })
  it('is never throwaway below the threshold, whatever the signal (sweep)', () => {
    for (const copy of ['same-picture', 'same-thing', null] as const)
      for (const t of [DEFAULT_THRESHOLDS, { throwaway: THROWAWAY_FLOOR, keep: 0.6 }])
        for (const r of [null, rule('keep', 0.9), rule('throwaway', 0.6), rule('throwaway', 0.95)])
          for (let i = 0; i <= 100; i++) {
            const v = decide(r, i === 100 ? null : i / 99, t, copy)
            if (v.proposal === 'throwaway') expect(1 - v.pKeep).toBeGreaterThanOrEqual(t.throwaway)
          }
  })
  it('the signal alone (no rule, no model) is only ever doubtful', () => {
    expect(decide(null, null, DEFAULT_THRESHOLDS, 'same-picture').proposal).toBe('doubtful')
  })
  it('does not touch a keep verdict or its reason', () => {
    const v = decide(rule('keep', 0.95), 0.95, DEFAULT_THRESHOLDS, 'same-thing')
    expect(v.proposal).toBe('keep')
    expect(v.reason).not.toMatch(/already kept/)
  })
})
