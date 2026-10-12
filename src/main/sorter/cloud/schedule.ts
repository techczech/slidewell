/**
 * When the nightly batch is due. Pure; times are the Mac's local clock.
 *
 * Rules:
 *   - The batch time is 'HH:MM' (default 02:00). The latest slot is the most recent local HH:MM at
 *     or before now.
 *   - Due when the nightly run is on and the latest slot falls after the anchor (effectiveAnchor):
 *     the later of the last run and the moment the schedule started. The schedule starts at the first check (so a
 *     fresh install never runs at once) and starts again whenever the cloud step or the nightly
 *     switch is turned on (service.ts restartSchedule), so a slot that passed while either was off
 *     is not caught up.
 *   - The app checks while it is running and at launch; a slot missed while the app was closed runs
 *     once at the next launch, however many nights were missed.
 */
export const DEFAULT_BATCH_TIME = '02:00'

export function parseBatchTime(s: unknown): { h: number; m: number } | null {
  if (typeof s !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  return h >= 0 && h < 24 && min >= 0 && min < 60 ? { h, m: min } : null
}

/** 'HH:MM', falling back to the default when the setting is not a valid time. */
export function normaliseBatchTime(s: unknown): string {
  const t = parseBatchTime(s) ?? (parseBatchTime(DEFAULT_BATCH_TIME) as { h: number; m: number })
  return `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}`
}

/** The most recent local HH:MM at or before `now`. */
export function latestSlot(now: Date, batchTime: string): Date {
  const t = parseBatchTime(normaliseBatchTime(batchTime)) as { h: number; m: number }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), t.h, t.m, 0, 0)
  return today.getTime() <= now.getTime() ? today : new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, t.h, t.m, 0, 0)
}

/** The next local HH:MM after `now`. */
export function nextSlot(now: Date, batchTime: string): Date {
  const last = latestSlot(now, batchTime)
  return new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1, last.getHours(), last.getMinutes(), 0, 0)
}

export type ScheduleInput = {
  now: Date
  enabled: boolean
  batchTime: string
  /** ISO time of the last nightly run (started), or null. */
  lastRunAt: string | null
  /** ISO time the schedule started (set on first check, and again when the cloud step or the nightly switch is turned on), or null when not yet set. */
  since: string | null
}

/**
 * The anchor the schedule goes by, from the two stored times as they read at `now`. Both isBatchDue
 * and nextRunAt use it, so the next run shown is the one the scheduler makes.
 *   - `since` that is not a time, or is later than now (the clock was ahead when it was written, or
 *     the file was edited), counts as now: nothing is caught up, and it never falls back to an older
 *     last run. `rewriteSince` is then true and service.ts tick() stores now in its place.
 *   - `since` that is missing (null or empty: a fresh install, or a config from before the field
 *     existed) gives no time of its own; the last run alone anchors, so a service that was on all
 *     along still catches up once at launch. `sinceMissing` is then true and tick() stores now.
 *   - a last run later than now is ignored.
 * `anchor` is null when neither gives a time: nothing is due until tick() has stored `since`.
 */
export function effectiveAnchor(s: { now: Date; lastRunAt: string | null; since: string | null }): { anchor: number | null; sinceMissing: boolean; rewriteSince: boolean } {
  const now = s.now.getTime()
  const last = typeof s.lastRunAt === 'string' ? Date.parse(s.lastRunAt) : NaN
  const times: number[] = Number.isFinite(last) && last <= now ? [last] : []
  const sinceMissing = s.since === null || s.since === undefined || s.since === ''
  let rewriteSince = false
  if (!sinceMissing) {
    const since = typeof s.since === 'string' ? Date.parse(s.since) : NaN
    rewriteSince = !Number.isFinite(since) || since > now
    times.push(rewriteSince ? now : since)
  }
  return { anchor: times.length ? Math.max(...times) : null, sinceMissing, rewriteSince }
}

export function isBatchDue(s: ScheduleInput): boolean {
  if (!s.enabled) return false
  const { anchor } = effectiveAnchor(s)
  if (anchor === null) return false
  const slot = latestSlot(s.now, s.batchTime).getTime()
  return slot > anchor && slot <= s.now.getTime()
}

/**
 * When the scheduler next starts the nightly batch, or null while the nightly run is off: now when a
 * batch is due (the next check starts it), otherwise the next slot after now.
 */
export function nextRunAt(s: ScheduleInput): Date | null {
  if (!s.enabled) return null
  return isBatchDue(s) ? new Date(s.now.getTime()) : nextSlot(s.now, s.batchTime)
}

/**
 * The night window `now` falls in, as the local date the night starts on ('YYYY-MM-DD'): a night runs
 * from local noon to the next local noon, so a 02:00 batch, a run after the batch time was moved and
 * a Sort now that evening or the next morning all count against the same night's limit. Fixed, not
 * tied to the batch time, so moving the batch time never opens a new window.
 */
export function nightOf(now: Date): string {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() - 12, now.getMinutes(), now.getSeconds())
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${start.getFullYear()}-${p(start.getMonth() + 1)}-${p(start.getDate())}`
}
