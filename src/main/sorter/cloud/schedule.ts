/**
 * When the nightly batch is due. Pure; times are the Mac's local clock.
 *
 * Rules:
 *   - The batch time is 'HH:MM' (default 02:00). The latest slot is the most recent local HH:MM at
 *     or before now.
 *   - Due when the nightly run is on and the latest slot falls after the anchor: the last run, or,
 *     before the first run, the moment the schedule started (so a fresh install never runs at once).
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
  /** ISO time the schedule started (set on first check), or null when not yet set. */
  since: string | null
}

export function isBatchDue(s: ScheduleInput): boolean {
  if (!s.enabled) return false
  const anchor = Date.parse(s.lastRunAt ?? s.since ?? '')
  if (!Number.isFinite(anchor)) return false
  const slot = latestSlot(s.now, s.batchTime).getTime()
  return slot > anchor && slot <= s.now.getTime()
}
