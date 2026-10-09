import { describe, it, expect } from 'vitest'
import { isBatchDue, latestSlot, nextSlot, normaliseBatchTime, parseBatchTime } from '../src/main/sorter/cloud/schedule'

const at = (d: number, h: number, m = 0): Date => new Date(2026, 9, d, h, m, 0, 0) // local time, October 2026
const iso = (d: Date): string => d.toISOString()

describe('batch time', () => {
  it('parses HH:MM and falls back to 02:00', () => {
    expect(parseBatchTime('02:00')).toEqual({ h: 2, m: 0 })
    expect(parseBatchTime('23:59')).toEqual({ h: 23, m: 59 })
    expect(parseBatchTime('24:00')).toBeNull()
    expect(parseBatchTime('2am')).toBeNull()
    expect(normaliseBatchTime('7:05')).toBe('07:05')
    expect(normaliseBatchTime(undefined)).toBe('02:00')
    expect(normaliseBatchTime('nonsense')).toBe('02:00')
  })

  it('latest and next slot', () => {
    expect(latestSlot(at(10, 1, 59), '02:00')).toEqual(at(9, 2))
    expect(latestSlot(at(10, 2, 0), '02:00')).toEqual(at(10, 2))
    expect(nextSlot(at(10, 2, 0), '02:00')).toEqual(at(11, 2))
    expect(nextSlot(at(10, 23, 0), '02:00')).toEqual(at(11, 2))
  })
})

describe('is a batch due', () => {
  const base = { enabled: true, batchTime: '02:00', lastRunAt: null as string | null, since: null as string | null }

  it('never before the schedule has an anchor, and never when switched off', () => {
    expect(isBatchDue({ ...base, now: at(10, 3) })).toBe(false)
    expect(isBatchDue({ ...base, enabled: false, now: at(10, 3), since: iso(at(1, 12)) })).toBe(false)
  })

  it('a fresh install waits for the first slot after it started', () => {
    const since = iso(at(10, 9)) // installed at 09:00, after today's slot
    expect(isBatchDue({ ...base, since, now: at(10, 23) })).toBe(false)
    expect(isBatchDue({ ...base, since, now: at(11, 1, 59) })).toBe(false)
    expect(isBatchDue({ ...base, since, now: at(11, 2, 0) })).toBe(true)
  })

  it('runs once per slot while the app is open', () => {
    expect(isBatchDue({ ...base, since: iso(at(1, 9)), lastRunAt: iso(at(10, 2, 0)), now: at(10, 2, 1) })).toBe(false)
    expect(isBatchDue({ ...base, since: iso(at(1, 9)), lastRunAt: iso(at(10, 2, 0)), now: at(11, 2, 0) })).toBe(true)
  })

  it('a slot missed while the app was closed runs at the next launch, once', () => {
    const last = iso(at(7, 2, 1))
    expect(isBatchDue({ ...base, since: iso(at(1, 9)), lastRunAt: last, now: at(10, 14) })).toBe(true) // three nights missed: due
    expect(isBatchDue({ ...base, since: iso(at(1, 9)), lastRunAt: iso(at(10, 14)), now: at(10, 14, 1) })).toBe(false) // ran at launch: not again until tomorrow
  })

  it('moving the time later the same day makes it due again at the new time', () => {
    const lastRunAt = iso(at(10, 2, 0))
    expect(isBatchDue({ ...base, batchTime: '22:30', since: iso(at(1, 9)), lastRunAt, now: at(10, 22, 29) })).toBe(false)
    expect(isBatchDue({ ...base, batchTime: '22:30', since: iso(at(1, 9)), lastRunAt, now: at(10, 22, 30) })).toBe(true)
  })
})
