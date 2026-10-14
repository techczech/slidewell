import { describe, it, expect } from 'vitest'
import type { SorterRetrain, SorterStatus } from '../src/preload'
import { aboutValues, retrainNotice, upNextHeading, whenWords } from '../src/renderer/src/teach-format'
import { fillCopy, RETRAIN_NOTICE, SORTER_ABOUT } from '../src/renderer/src/sorter-about-copy'

const now = new Date(2026, 9, 14, 15, 0)
const at = new Date(2026, 9, 14, 14, 2).toISOString()
const retrain = (over: Partial<SorterRetrain> = {}): SorterRetrain => ({
  at,
  trigger: 'auto',
  choices: { before: 312, after: 322 },
  needALook: { before: 41, after: 18 },
  movedToSure: { keep: 19, throwaway: 4 },
  accuracy: { before: null, after: { throwawayRight: 0.94, keepRight: 0.96 } },
  movedHashes: ['m030'],
  ...over
})
const status = (over: Partial<SorterStatus> = {}): SorterStatus =>
  ({ learnable: { kept: 228, binned: 84 }, report: { trainedAt: at, thresholds: { keep: 0.7, throwaway: 0.7 } }, retrainEvery: 10, autoRetrain: true, autoRetrainOnBattery: false, ...over }) as SorterStatus

describe('the notice after a retrain', () => {
  it('is one slot per piece: when, choices, what moved (keep / throwaway), how many still need a look', () => {
    const s = retrainNotice(retrain(), 18, now)
    expect(s.map((x) => x.slot)).toEqual(['when', 'learnedFrom', 'moved', 'stillNeed'])
    expect(s[0].text).toBe(fillCopy(RETRAIN_NOTICE.when, { when: 'today at 14:02' }))
    expect(s[1].text).toBe(fillCopy(RETRAIN_NOTICE.learnedFrom, { choices: '322' }))
    expect(s[2].text).toBe(fillCopy(RETRAIN_NOTICE.moved, { moved: '23', keep: '19', throwaway: '4' }))
    expect(s[3].text).toBe(fillCopy(RETRAIN_NOTICE.stillNeed, { needALook: '18' }))
    // every {name} is filled
    for (const x of s) expect(x.text).not.toMatch(/\{\w+\}/)
  })
  it('says so through its own slot when nothing moved, and when what moved could not be checked', () => {
    expect(retrainNotice(retrain({ movedToSure: { keep: 0, throwaway: 0 }, movedHashes: [] }), 41, now).map((x) => x.slot)).toEqual(['when', 'learnedFrom', 'nothingMoved', 'stillNeed'])
    expect(retrainNotice(retrain({ needALook: null, movedToSure: null, movedHashes: [] }), 41, now).map((x) => x.slot)).toEqual(['when', 'learnedFrom', 'notChecked', 'stillNeed'])
  })
  it('the still-need-a-look count is the one Review shows, not the re-score set', () => {
    expect(retrainNotice(retrain(), 69, now)[3].text).toContain('69')
  })
})

describe('when, in words', () => {
  it('today, yesterday, last night, a date; nothing for an unreadable time', () => {
    expect(whenWords(at, now)).toBe('today at 14:02')
    expect(whenWords(new Date(2026, 9, 13, 21, 10).toISOString(), now)).toBe('yesterday at 21:10')
    expect(whenWords(new Date(2026, 9, 13, 2, 0).toISOString(), now)).toBe('last night at 02:00')
    expect(whenWords(new Date(2026, 9, 7, 2, 0).toISOString(), now)).toBe('on 7 Oct at 02:00')
    expect(whenWords('not a time', now)).toBe('')
    expect(whenWords(null, now)).toBe('')
  })
})

describe('Up next heading', () => {
  it('counts places the way "Question 1 of N" and "N need a look" do', () => {
    expect(upNextHeading(5, 69, true)).toBe('Up next · 2–6 of 69, most unsure first')
    expect(upNextHeading(5, 69, false)).toBe('Up next · 2–6 of 69')
    expect(upNextHeading(1, 2, false)).toBe('Up next · 2 of 2')
    expect(upNextHeading(0, 1, true)).toBe('Up next · nothing else')
  })
})

describe('About the sorter', () => {
  it('has the six sections in order, each with a heading and words', () => {
    expect(SORTER_ABOUT.sections.map((s) => s.heading)).toEqual([
      'What it looks at',
      'Where it learns from',
      'How training works',
      'How the rules by app and window are made',
      'Where it is stored',
      'What leaves your Mac'
    ])
    for (const s of SORTER_ABOUT.sections) expect(s.paragraphs.length).toBeGreaterThan(0)
  })
  it('fills the live numbers from the sorter status: choices, last trained, sure at, retrain setting', () => {
    const v = aboutValues(status(), now)
    expect(v.choices).toBe(fillCopy(SORTER_ABOUT.values.choices, { choices: '312', kept: '228', thrownAway: '84' }))
    expect(v.lastTrained).toBe(fillCopy(SORTER_ABOUT.values.lastTrained, { when: 'today at 14:02' }))
    expect(v.sureAt).toBe(fillCopy(SORTER_ABOUT.values.sureAt, { sure: 70 }))
    expect(v.retrain).toBe(`${fillCopy(SORTER_ABOUT.values.retrainOn, { every: '10' })}, ${SORTER_ABOUT.values.notOnBattery}`)
    for (const x of Object.values(v)) expect(x).not.toMatch(/\{\w+\}/)
  })
  it('says what it can when the sorter was never trained, has differing thresholds, or retrains on battery or not at all', () => {
    const never = aboutValues(status({ report: null, learnable: null }), now)
    expect(never.lastTrained).toBe(SORTER_ABOUT.values.notTrained)
    expect(never.sureAt).toBe(SORTER_ABOUT.values.sureUnknown)
    expect(never.choices).toBe(SORTER_ABOUT.values.noChoices)
    const split = aboutValues(status({ report: { trainedAt: at, thresholds: { keep: 0.8, throwaway: 0.9 } } as SorterStatus['report'] }), now)
    expect(split.sureAt).toBe(fillCopy(SORTER_ABOUT.values.sureAtSplit, { keep: 80, throwaway: 90 }))
    expect(aboutValues(status({ autoRetrainOnBattery: true }), now).retrain).toContain(SORTER_ABOUT.values.onBattery)
    expect(aboutValues(status({ autoRetrain: false }), now).retrain).toBe(SORTER_ABOUT.values.retrainOff)
  })
})
