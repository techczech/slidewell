/**
 * Pure parser for screenshot file names (capture inbox). NO electron/fs imports, so it is unit-testable
 * in vitest. Recognises CleanShot names (`CleanShot 2026-10-08 at 0801 from Google Chrome with Some Window.png`,
 * also `at 08.01.23@2x`) and macOS names (`Screenshot 2026-10-08 at 10.05.01.png`, `Screen Shot … 10.05.01 AM`).
 * Anything else returns null — the Desktop source uses that to ignore files that are not screenshots.
 */
export type ParsedScreenshotName = {
  origin: 'cleanshot' | 'macos'
  takenAt: string // local time, YYYY-MM-DDTHH:MM:SS
  date: string // YYYY-MM-DD
  app: string | null
  window: string | null
}

const CLEANSHOT =
  /^CleanShot (\d{4})-(\d{2})-(\d{2}) at (\d{2})[.:]?(\d{2})(?:[.:]?(\d{2}))?(?:@\d+x)?(?: from (.+?))?(?: with (.+))?$/
const MACOS = /^Screen ?[Ss]hot (\d{4})-(\d{2})-(\d{2}) at (\d{1,2})\.(\d{2})\.(\d{2})(?:[\s ]*([AaPp][Mm]))?(?: \(\d+\))?$/

function stamp(y: string, mo: string, d: string, h: number, mi: number, s: number): { takenAt: string; date: string } | null {
  const month = Number(mo)
  const day = Number(d)
  if (month < 1 || month > 12 || day < 1 || day > 31 || h > 23 || mi > 59 || s > 59) return null
  const p = (n: number): string => String(n).padStart(2, '0')
  const date = `${y}-${mo}-${d}`
  return { date, takenAt: `${date}T${p(h)}:${p(mi)}:${p(s)}` }
}

export function parseScreenshotName(filename: string): ParsedScreenshotName | null {
  const base = filename.replace(/^.*[\\/]/, '').replace(/\.[A-Za-z0-9]{2,5}$/, '').trim()
  let m = CLEANSHOT.exec(base)
  if (m) {
    const t = stamp(m[1], m[2], m[3], Number(m[4]), Number(m[5]), Number(m[6] ?? 0))
    if (!t) return null
    return { origin: 'cleanshot', ...t, app: m[7]?.trim() || null, window: m[8]?.trim() || null }
  }
  m = MACOS.exec(base)
  if (m) {
    let h = Number(m[4])
    if (m[7]) {
      const pm = m[7].toLowerCase() === 'pm'
      if (h < 1 || h > 12) return null
      h = (h % 12) + (pm ? 12 : 0)
    }
    const t = stamp(m[1], m[2], m[3], h, Number(m[5]), Number(m[6]))
    return t ? { origin: 'macos', ...t, app: null, window: null } : null
  }
  return null
}
