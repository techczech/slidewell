import { describe, it, expect } from 'vitest'
import { BIN_AFTER_DAYS, binToken, daysLeft, pileOf, planAction, summarise, type PileFacts } from '../src/main/review/piles'

const DAY = 86_400_000
const T0 = Date.parse('2026-10-01T09:00:00Z')
const iso = (t: number): string => new Date(t).toISOString()
const facts = (p: Partial<PileFacts>): PileFacts => ({ proposal: 'doubtful', proposedAt: iso(T0), throwawaySince: null, decision: null, ...p })

describe('review piles: where an item sits', () => {
  it('without a decision of his, the proposal decides: doubtful queue, kept, throwaway', () => {
    expect(pileOf(facts({ proposal: 'doubtful' }), T0)).toEqual({ pile: 'doubtful', by: 'sorter', binInDays: null })
    expect(pileOf(facts({ proposal: 'keep' }), T0)).toEqual({ pile: 'kept', by: 'sorter', binInDays: null })
    expect(pileOf(facts({ proposal: 'throwaway', throwawaySince: iso(T0) }), T0)).toEqual({ pile: 'throwaway', by: 'sorter', binInDays: 30 })
  })

  it('his decision overrides the proposal: keep (staged or in the well), throwaway, emptied', () => {
    expect(pileOf(facts({ proposal: 'throwaway', decision: { state: 'included', decidedAt: iso(T0) } }), T0).pile).toBe('kept')
    expect(pileOf(facts({ proposal: 'throwaway', decision: { state: 'selected', decidedAt: iso(T0) } }), T0)).toMatchObject({ pile: 'kept', by: 'you' })
    expect(pileOf(facts({ proposal: 'keep', decision: { state: 'excluded', decidedAt: iso(T0) } }), T0)).toEqual({ pile: 'throwaway', by: 'you', binInDays: 30 })
    expect(pileOf(facts({ proposal: 'doubtful', decision: { state: 'emptied', decidedAt: iso(T0) } }), T0).pile).toBe('gone')
    expect(pileOf(facts({ proposal: 'doubtful', decision: { state: 'undecided', decidedAt: null } }), T0).pile).toBe('doubtful')
  })

  it('the 30-day clock: bin in 30 days on the day, 1 day on day 29, the Bin on day 30', () => {
    const his = facts({ decision: { state: 'excluded', decidedAt: iso(T0) } })
    expect(pileOf(his, T0 + 1000).binInDays).toBe(30)
    expect(pileOf(his, T0 + 1 * DAY).binInDays).toBe(29)
    expect(pileOf(his, T0 + 29 * DAY).binInDays).toBe(1)
    expect(pileOf(his, T0 + 30 * DAY - 1)).toMatchObject({ pile: 'throwaway', binInDays: 1 })
    expect(pileOf(his, T0 + BIN_AFTER_DAYS * DAY)).toEqual({ pile: 'bin', by: 'you', binInDays: null })
    expect(pileOf(his, T0 + 400 * DAY).pile).toBe('bin')
  })

  it("the sorter's throwaway clock runs from when it first proposed throwaway, else from the proposal", () => {
    const since = facts({ proposal: 'throwaway', proposedAt: iso(T0 + 20 * DAY), throwawaySince: iso(T0) })
    expect(pileOf(since, T0 + 30 * DAY).pile).toBe('bin') // a later re-sort does not restart the clock
    const noSince = facts({ proposal: 'throwaway', proposedAt: iso(T0), throwawaySince: null })
    expect(pileOf(noSince, T0 + 10 * DAY).binInDays).toBe(20)
  })

  it('when unsure, keep: a missing or unreadable date never pushes an item toward the Bin', () => {
    expect(daysLeft(null, T0)).toBe(30)
    expect(daysLeft('not a date', T0)).toBe(30)
    expect(pileOf(facts({ decision: { state: 'excluded', decidedAt: null } }), T0 + 999 * DAY)).toMatchObject({ pile: 'throwaway', binInDays: 30 })
    expect(daysLeft(iso(T0 + 5 * DAY), T0)).toBe(30) // a date in the future is capped at 30
  })
})

describe('review piles: transitions', () => {
  const at = (p: PileFacts, now = T0) => pileOf(p, now)

  it('keep: from doubtful, the sorter’s keep, throwaway and bin becomes his keep, promoted into the well', () => {
    for (const p of [facts({}), facts({ proposal: 'keep' }), facts({ proposal: 'throwaway', throwawaySince: iso(T0) })]) {
      expect(planAction(at(p), 'keep', T0)).toEqual({ kind: 'decide', state: 'selected', decidedAt: iso(T0), answer: 'keep', promote: true })
    }
    const binned = facts({ decision: { state: 'excluded', decidedAt: iso(T0) } })
    expect(planAction(at(binned, T0 + 31 * DAY), 'keep', T0 + 31 * DAY)).toMatchObject({ kind: 'decide', state: 'selected' })
    expect(planAction(at(facts({ decision: { state: 'included', decidedAt: iso(T0) } })), 'keep', T0)).toMatchObject({ kind: 'noop' })
  })

  it('throwaway: from doubtful or kept becomes his throwaway, clock from now; already thrown away is a noop', () => {
    expect(planAction(at(facts({})), 'throwaway', T0)).toEqual({ kind: 'decide', state: 'excluded', decidedAt: iso(T0), answer: 'throwaway', promote: false })
    expect(planAction(at(facts({ decision: { state: 'included', decidedAt: iso(T0) } })), 'throwaway', T0)).toMatchObject({ kind: 'decide', state: 'excluded' })
    expect(planAction(at(facts({ proposal: 'throwaway', throwawaySince: iso(T0) })), 'throwaway', T0)).toMatchObject({ kind: 'noop' })
    const after = { proposal: 'doubtful' as const, proposedAt: iso(T0), throwawaySince: null, decision: { state: 'excluded', decidedAt: iso(T0 + 5 * DAY) } }
    expect(pileOf(after, T0 + 5 * DAY).binInDays).toBe(30)
  })

  it('rescue: from Throwaway and from the Bin it is kept; elsewhere refused', () => {
    const toss = facts({ decision: { state: 'excluded', decidedAt: iso(T0) } })
    expect(planAction(at(toss, T0 + DAY), 'rescue', T0 + DAY)).toMatchObject({ kind: 'decide', state: 'selected', answer: 'keep', promote: true })
    expect(planAction(at(toss, T0 + 45 * DAY), 'rescue', T0 + 45 * DAY)).toMatchObject({ kind: 'decide', state: 'selected' })
    const sorterToss = facts({ proposal: 'throwaway', throwawaySince: iso(T0) })
    expect(planAction(at(sorterToss, T0 + 40 * DAY), 'rescue', T0 + 40 * DAY)).toMatchObject({ kind: 'decide', state: 'selected' })
    expect(planAction(at(facts({})), 'rescue', T0)).toMatchObject({ kind: 'refused' })
  })

  it('an emptied item cannot be acted on', () => {
    const gone = at(facts({ decision: { state: 'emptied', decidedAt: iso(T0) } }))
    for (const a of ['keep', 'throwaway', 'rescue'] as const) expect(planAction(gone, a, T0).kind).toBe('refused')
  })
})

describe('review piles: counts and the Bin token', () => {
  it('sorted confidently = keep/throwaway proposals he has not overridden', () => {
    const rows = [
      { p: facts({ proposal: 'doubtful' }), decided: false },
      { p: facts({ proposal: 'keep' }), decided: false },
      { p: facts({ proposal: 'keep', decision: { state: 'excluded', decidedAt: iso(T0) } }), decided: true },
      { p: facts({ proposal: 'throwaway', throwawaySince: iso(T0) }), decided: false },
      { p: facts({ proposal: 'throwaway', throwawaySince: iso(T0 - 40 * DAY) }), decided: false }
    ]
    const s = summarise(rows.map((r) => ({ view: pileOf(r.p, T0), proposal: r.p.proposal, decided: r.decided })))
    expect(s).toEqual({ needALook: 1, kept: 1, throwaway: 2, bin: 1, confidentKept: 1, confidentThrowaway: 2 })
  })

  it('the token changes when the Bin changes and not with order', () => {
    expect(binToken(['a', 'b'])).toBe(binToken(['b', 'a']))
    expect(binToken(['a', 'b'])).not.toBe(binToken(['a', 'b', 'c']))
    expect(binToken(['a', 'b'])).not.toBe(binToken(['a', 'c']))
  })
})
