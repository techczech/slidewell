import { describe, it, expect } from 'vitest'
import type { SorterLearning, SorterRetrain, SorterStatus } from '../src/preload'
import { balanceNote, certainty, chartModel, chartPct, nextRetrain, perFifty, readingWords, retrainSummary, stripLine } from '../src/renderer/src/teach-format'

const status = (over: Partial<SorterStatus> = {}): SorterStatus =>
  ({ learnable: { kept: 228, binned: 84 }, report: null, answersSinceTraining: 4, retrainEvery: 10, autoRetrain: true, autoRetrainOnBattery: false, retraining: null, waitingForPower: null, choicesNeeded: 0, lastRetrain: null, ...over }) as SorterStatus

const points = [
  { choices: 50, throwawayRight: 0.74, needALook: 0.46 },
  { choices: 100, throwawayRight: 0.83, needALook: 0.34 },
  { choices: 150, throwawayRight: 0.87, needALook: 0.25 },
  { choices: 200, throwawayRight: 0.895, needALook: 0.19 },
  { choices: 250, throwawayRight: 0.905, needALook: 0.16 },
  { choices: 312, throwawayRight: 0.91, needALook: 0.135 }
]
const learning = (over: Partial<SorterLearning> = {}): SorterLearning => ({ verdict: 'still-helping', more: 0, minimum: 92, choices: 312, kept: 228, thrownAway: 84, heldBack: 60, points, trainedAt: null, ...over })

describe('the strip line', () => {
  it('counts to the next retrain', () => {
    const l = stripLine(status(), 41)
    expect(l.kind).toBe('counting')
    expect(l.text).toBe('Sorter: 312 choices · 41 need a look · retrains after every 10 answers (6 to go)')
    expect(l.action).toBeNull()
  })
  it('says when it is retraining, and by what', () => {
    expect(stripLine(status({ retraining: 'auto' }), 41).text).toContain('retraining by itself after ten answers on 312 choices')
    expect(stripLine(status({ retraining: 'manual' }), 41).kind).toBe('retraining')
  })
  it('offers Retrain now while waiting for power, and Retrain when it is off', () => {
    const w = stripLine(status({ waitingForPower: { answers: 10 }, answersSinceTraining: 10 }), 41)
    expect(w.kind).toBe('waiting')
    expect(w.action).toEqual({ id: 'retrain-now', label: 'Retrain now' })
    const off = stripLine(status({ autoRetrain: false, answersSinceTraining: 7 }), 41)
    expect(off.text).toContain('retraining by itself is off (7 answers since it last trained)')
    expect(off.action?.label).toBe('Retrain')
  })
  it('running beats waiting, and too few choices beats off', () => {
    expect(stripLine(status({ retraining: 'manual', waitingForPower: { answers: 10 } }), 1).kind).toBe('retraining')
    expect(stripLine(status({ choicesNeeded: 52, autoRetrain: false }), 1).kind).toBe('few')
  })
  it('never counts below zero to go', () => {
    expect(stripLine(status({ answersSinceTraining: 12 }), 3).text).toContain('retraining next')
    expect(nextRetrain(status({ answersSinceTraining: 0 }))).toBe('Next retrain after 10 more answers (10 to go)')
  })
})

describe('what a retrain moved', () => {
  const r: SorterRetrain = { at: 'x', trigger: 'auto', choices: { before: 312, after: 322 }, needALook: { before: 41, after: 18 }, movedToSure: { keep: 19, throwaway: 4 }, accuracy: { before: { throwawayRight: 0.91, keepRight: 0.95 }, after: { throwawayRight: 0.94, keepRight: 0.96 } }, movedHashes: [] }
  it('gives the move, need a look and both accuracies before and after', () => {
    expect(retrainSummary(r)).toBe('Retrained on 322 choices. 23 screenshots left the need-a-look queue (19 keep, 4 throwaway). Need a look: 41 → 18. Throwaway right: 91% → 94%. Keep right: 95% → 96%.')
  })
  it('says only that it retrained, with the accuracy, when the move could not be checked', () => {
    expect(retrainSummary({ ...r, needALook: null, movedToSure: null, accuracy: { before: null, after: { throwawayRight: 0.94, keepRight: null } } })).toBe('Retrained on 322 choices. Throwaway right: 94%.')
  })
})

describe('the reading', () => {
  it('turns the points into the gain per extra 50 choices', () => {
    expect(perFifty(points)).toEqual([9, 4, 2.5, 1, 0.4])
    expect(perFifty([{ choices: 50, throwawayRight: null, needALook: 0.4 }, { choices: 100, throwawayRight: 0.8, needALook: 0.3 }])).toEqual([])
  })
  it('words the three verdicts', () => {
    expect(readingWords(learning()).headline).toBe('312 choices so far. More would still help.')
    expect(readingWords(learning()).sub).toBe('Throwaway accuracy has levelled off, but the share it is unsure about is still falling.')
    expect(readingWords(learning({ verdict: 'levelling-off' })).headline).toBe('312 choices so far. Another round is unlikely to change much.')
    const few = readingWords(learning({ verdict: 'not-enough', more: 52, choices: 40, points: [] }))
    expect(few.headline).toBe('40 choices so far. It needs 52 more before it can be tested.')
    expect(few.sub).toContain('92 choices, 46 kept and 46 thrown away')
  })
  it('names the error when there are no points although there are enough choices', () => {
    expect(readingWords(learning({ points: [], error: 'the model is missing' })).sub).toBe('The reading could not be worked out: the model is missing')
  })
  it('never says "binned"', () => {
    const all = [readingWords(learning()), readingWords(learning({ verdict: 'not-enough', points: [] })), { headline: balanceNote(228, 84), sub: balanceNote(84, 228) + balanceNote(100, 100) }]
    expect(JSON.stringify(all)).not.toMatch(/binned/i)
  })
})

describe('the chart geometry', () => {
  it('puts the points where the locked frame has them', () => {
    const m = chartModel({ points, minimum: 92 })
    expect(m.throwaway.dots[0]).toMatchObject({ y: 160.7, label: '74%' })
    expect(m.throwaway.dots[0].x).toBeCloseTo(153.2, 0)
    expect(m.needALook.dots[5]).toMatchObject({ label: '13.5%', last: true })
    expect(m.throwaway.dots[3].label).toBe('89.5%')
    expect(m.topTicks.map((t) => t.label)).toEqual(['70%', '80%', '90%', '100%'])
    expect(m.lowTicks.map((t) => t.label)).toEqual(['0%', '20%', '40%', '60%'])
    expect(m.minimumX).toBeGreaterThan(m.xTicks[0].x)
    expect(m.minimumX).toBeLessThan(m.xTicks[2].x)
  })
  it('breaks the line at a point that could not be measured, and widens a panel when a value needs it', () => {
    const m = chartModel({ minimum: 92, points: [{ choices: 50, throwawayRight: 0.55, needALook: 0.8 }, { choices: 100, throwawayRight: null, needALook: 0.7 }, { choices: 150, throwawayRight: 0.6, needALook: 0.6 }] })
    expect(m.throwaway.dots).toHaveLength(2)
    expect(m.throwaway.line).toEqual([])
    expect(m.topTicks[0].label).toBe('50%')
    expect(m.lowTicks.at(-1)?.label).toBe('80%')
  })
  it('formats shares', () => {
    expect(chartPct(0.895)).toBe('89.5%')
    expect(chartPct(0.91)).toBe('91%')
  })
})

describe('certainty', () => {
  it('reads how sure it is of the way it leans', () => {
    expect(certainty(0.38, 'throwaway')).toEqual({ keep: 38, throwaway: 62, sure: 62, lean: 'throwaway' })
    expect(certainty(0.7, 'keep').sure).toBe(70)
  })
})
