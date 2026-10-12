/**
 * The period a manual sort is limited to: the last 7, 30 or 90 days, or everything. Pure: no I/O.
 *
 * A screenshot's date is the capture time in its file name (triage_fts.taken_at, store.ts
 * Shot.takenAt): local wall-clock time, 'YYYY-MM-DDTHH:MM:SS', '' when the name carries none. The
 * cut-off is the same kind of value: the wall-clock time `days` calendar days before `now`, same time
 * of day, so the two compare as text and a clock change (summer time) in between moves nothing.
 * A screenshot is in the period when its time is at or after the cut-off. One with no usable date is
 * in no period except Everything.
 *
 * Only this module turns a period into a cut-off, and only from a value it has checked: an unknown
 * period gives no window at all (periodWindow returns null), never Everything.
 */

export const SORT_PERIODS = ['7d', '30d', '90d', 'all'] as const
export type SortPeriod = (typeof SORT_PERIODS)[number]
/** What a manual sort covers when no period was ever chosen: everything, as before there was a choice. */
export const DEFAULT_SORT_PERIOD: SortPeriod = 'all'

const DAYS: Record<SortPeriod, number | null> = { '7d': 7, '30d': 30, '90d': 90, all: null }

export function isSortPeriod(x: unknown): x is SortPeriod {
  return typeof x === 'string' && (SORT_PERIODS as readonly string[]).includes(x)
}

/**
 * The period stored in config: the default when none was ever stored (undefined or null), the stored
 * one when it is one of the four, and null for anything else. Null is not Everything: nothing is
 * sorted or sent until a period is chosen again.
 */
export function storedPeriod(raw: unknown): SortPeriod | null {
  if (raw === undefined || raw === null) return DEFAULT_SORT_PERIOD
  return isSortPeriod(raw) ? raw : null
}

/** As the choice shows it: 'Last 30 days', 'Everything'. */
export function periodLabel(p: SortPeriod): string {
  const d = DAYS[p]
  return d === null ? 'Everything' : `Last ${d} days`
}

/** Inside a sentence, after a noun: ' from the last 30 days'; '' for everything. */
export function periodPhrase(p: SortPeriod): string {
  const d = DAYS[p]
  return d === null ? '' : ` from the last ${d} days`
}

/** Before a count, in a sentence about one period: 'Last 30 days: '; '' for everything. */
export function periodPrefix(p: SortPeriod): string {
  return DAYS[p] === null ? '' : `${periodLabel(p)}: `
}

/** One or two sentences saying what the period leaves out, for the confirm box and main's dialog. */
export function periodNote(p: SortPeriod): string {
  const d = DAYS[p]
  return d === null
    ? 'Period: everything, whatever the date.'
    : `Period: the last ${d} days, by the date in each file name. Screenshots taken before that, or with no date in their name, are not sorted or sent and stay as they are.`
}

/** The choices in the order shown. */
export const PERIOD_CHOICES: ReadonlyArray<{ id: SortPeriod; label: string }> = SORT_PERIODS.map((id) => ({ id, label: periodLabel(id) }))

const p2 = (n: number): string => String(n).padStart(2, '0')

/**
 * The cut-off for a period at `now`: local wall-clock time `days` calendar days earlier, as
 * 'YYYY-MM-DDTHH:MM:SS'; null for everything. The days are taken off the calendar date, not off the
 * clock, so the time of day stays the same across a summer-time change.
 */
export function cutoffFor(p: SortPeriod, now: Date): string | null {
  const days = DAYS[p]
  if (days === null) return null
  // calendar arithmetic on the local date and time, done in UTC so no clock change touches it
  const t = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() - days, now.getHours(), now.getMinutes(), now.getSeconds()))
  return `${String(t.getUTCFullYear()).padStart(4, '0')}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}T${p2(t.getUTCHours())}:${p2(t.getUTCMinutes())}:${p2(t.getUTCSeconds())}`
}

const TAKEN_AT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/

/** A capture time that can be compared with a cut-off: the full local form, naming a real date and time. */
export function usableTakenAt(takenAt: unknown): takenAt is string {
  if (typeof takenAt !== 'string') return false
  const m = TAKEN_AT.exec(takenAt)
  if (!m) return false
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number)
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return false
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate()
}

/**
 * A period with its cut-off, as one manual run uses it from start to finish. Made only by
 * periodWindow (and EVERYTHING); the cut-off is always main's own, never a value from the renderer.
 */
export type PeriodWindow = { readonly period: SortPeriod; readonly cutoff: string | null }

/** No limit: the nightly run, and a manual run under Everything. */
export const EVERYTHING: PeriodWindow = Object.freeze({ period: 'all', cutoff: null })

/** The window for a period value at `now`; null when the value is not one of the four periods. */
export function periodWindow(period: unknown, now: Date): PeriodWindow | null {
  if (!isSortPeriod(period)) return null
  return Object.freeze({ period, cutoff: cutoffFor(period, now) })
}

/**
 * Whether a screenshot taken at `takenAt` is inside the window. Everything takes all of them, dated
 * or not; any other period takes only those with a usable date at or after the cut-off. A window
 * that is not everything and has no cut-off takes nothing.
 */
export function inWindow(takenAt: unknown, w: PeriodWindow): boolean {
  if (w.period === 'all') return w.cutoff === null
  if (!w.cutoff || !usableTakenAt(w.cutoff)) return false
  return usableTakenAt(takenAt) && takenAt >= w.cutoff
}

/** Shown when the stored period is not one of the four. Nothing is sorted or sent then. */
export const PERIOD_UNREADABLE = 'The period saved in Settings could not be read, so nothing was sorted. Choose a period and try again.'
/** Shown when a period that is not one of the four is asked for. */
export const PERIOD_REFUSED = 'That is not one of the periods, so nothing was changed.'
