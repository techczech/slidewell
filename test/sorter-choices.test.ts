import { describe, it, expect } from 'vitest'
import { answersSince, choicesAtTraining, MIN_CHOICES, moreChoicesNeeded, RETRAIN_EVERY } from '../src/main/sorter/choices'

describe('teaching: counting his choices', () => {
  it('answers since the last training = choices now minus choices at the training, never below 0', () => {
    expect(answersSince({ kept: 234, binned: 88 }, 312)).toBe(10)
    expect(answersSince({ kept: 228, binned: 84 }, 312)).toBe(0)
    expect(answersSince({ kept: 227, binned: 84 }, 312)).toBe(0) // a decision undone
  })

  it('is 0 while nothing is counted or there is no current model', () => {
    expect(answersSince(null, 312)).toBe(0)
    expect(answersSince({ kept: 300, binned: 90 }, null)).toBe(0)
    expect(answersSince({ kept: 300, binned: 90 }, Number.NaN)).toBe(0)
  })

  it('reads the choices at training from the report, or from the embedded count on an older report', () => {
    expect(choicesAtTraining({ choicesAtTraining: 312, usable: { keep: 220, throwaway: 80 } })).toBe(312)
    expect(choicesAtTraining({ usable: { keep: 220, throwaway: 80 } })).toBe(300)
    expect(choicesAtTraining(null)).toBeNull()
    expect(choicesAtTraining({})).toBeNull()
  })

  it('the retrain threshold is ten and the minimum just under a hundred', () => {
    expect(RETRAIN_EVERY).toBe(10)
    expect(MIN_CHOICES).toBe(92)
  })

  it('says how many more choices a measurable training needs: enough of each kind, then enough in all', () => {
    expect(moreChoicesNeeded({ kept: 70, binned: 30 })).toBe(0) // held back 14 + 6 = 20
    expect(moreChoicesNeeded({ kept: 228, binned: 84 })).toBe(0)
    expect(moreChoicesNeeded({ kept: 60, binned: 30 })).toBe(6) // held back 12 + 6 = 18: two more held back = six more choices
    expect(moreChoicesNeeded({ kept: 200, binned: 4 })).toBe(17) // 21 thrown away are needed for 5 held back
    expect(moreChoicesNeeded({ kept: 0, binned: 0 })).toBe(92) // 46 of each kind: 10 + 10 held back
    expect(moreChoicesNeeded(null)).toBe(92)
  })
})
