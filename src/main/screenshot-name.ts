/**
 * Pure parser for screenshot file names (capture inbox). NO electron/fs imports, so it is unit-testable
 * in vitest. Recognises:
 *  - names built from CleanShot's own `mediaNameTemplate` preference (ticket 15), compiled once with
 *    `compileNameTemplate` and passed in. Dominik's template gives
 *    `CleanShot 2026-10-10 at 1147from TalkWeaver with TalkWeaver.png`;
 *  - CleanShot's default style (`CleanShot 2026-10-08 at 10.39.03@2x.png`, also `at 0801 from <app> with <window>`);
 *  - macOS names (`Screenshot 2026-10-08 at 10.05.01.png`, `Screen Shot … 10.05.01 AM`).
 * Anything else returns null — the Desktop source uses that to ignore files that are not screenshots.
 */
export type ParsedScreenshotName = {
  origin: 'cleanshot' | 'macos'
  takenAt: string // local time, YYYY-MM-DDTHH:MM:SS
  date: string // YYYY-MM-DD
  app: string | null
  window: string | null
}

type Field = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second' | 'app' | 'window'

/** A compiled CleanShot name template. Build with `compileNameTemplate`; opaque to callers. */
export type NameTemplate = { readonly re: RegExp; readonly fields: readonly Field[]; readonly parts: readonly string[] }

const CLEANSHOT =
  /^CleanShot (\d{4})-(\d{2})-(\d{2}) at (\d{2})[.:]?(\d{2})(?:[.:]?(\d{2}))?(?:@\d+x)?(?: ?from (.+?))?(?: with ?(.*))?$/
const MACOS = /^Screen ?[Ss]hot (\d{4})-(\d{2})-(\d{2}) at (\d{1,2})\.(\d{2})\.(\d{2})(?:[\s ]*([AaPp][Mm]))?(?: \(\d+\))?$/

// CleanShot template tokens. Unknown `%x` tokens match any text (lazily) and are not read.
const TOKEN: Record<string, { field: Field; re: string } | undefined> = {
  y: { field: 'year', re: '(\\d{4}|\\d{2})' },
  Y: { field: 'year', re: '(\\d{4}|\\d{2})' },
  m: { field: 'month', re: '(\\d{2})' },
  d: { field: 'day', re: '(\\d{2})' },
  H: { field: 'hour', re: '(\\d{2})' },
  M: { field: 'minute', re: '(\\d{2})' },
  S: { field: 'second', re: '(\\d{2})' },
  s: { field: 'second', re: '(\\d{2})' },
  a: { field: 'app', re: '(.*?)' },
  t: { field: 'window', re: '(.*?)' }
}
const RETINA = '(?:@\\d+x)?'
// Finder / CleanShot duplicate counters at the very end: `name 2`, `name (2)`
const DUPLICATE = '(?:\\s\\d+|\\s\\(\\d+\\))?'
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Compile CleanShot's `mediaNameTemplate` (the array of literal and `%x` parts). Whitespace in the
 * literals is matched loosely, because CleanShot trims the name (`… with.png` when the window title is
 * empty). Returns null for a template without a full date (year, month and day): such names could not
 * be told apart from ordinary files.
 */
export function compileNameTemplate(parts: readonly string[] | null | undefined): NameTemplate | null {
  if (!parts || parts.length === 0) return null
  const fields: Field[] = []
  let re = '^'
  for (const part of parts) {
    for (const piece of String(part).split(/(%[A-Za-z])/)) {
      if (!piece) continue
      if (/^%[A-Za-z]$/.test(piece)) {
        const t = TOKEN[piece[1]]
        if (!t || fields.includes(t.field)) re += '.*?'
        else {
          fields.push(t.field)
          re += t.re
          if (t.field === 'hour' || t.field === 'minute' || t.field === 'second') re += RETINA
        }
      } else {
        re += piece
          .split(/(\s+)/)
          .map((w) => (/^\s+$/.test(w) ? '\\s*' : escapeRe(w)))
          .join('')
      }
    }
  }
  if (!fields.includes('year') || !fields.includes('month') || !fields.includes('day')) return null
  re += `${RETINA}${DUPLICATE}$`
  try {
    return { re: new RegExp(re, 'u'), fields, parts: [...parts] }
  } catch {
    return null
  }
}

function stamp(y: string, mo: string, d: string, h: number, mi: number, s: number): { takenAt: string; date: string } | null {
  const year = y.length === 2 ? `20${y}` : y
  const month = Number(mo)
  const day = Number(d)
  if (month < 1 || month > 12 || day < 1 || day > 31 || h > 23 || mi > 59 || s > 59) return null
  const p = (n: number): string => String(n).padStart(2, '0')
  const date = `${year}-${mo}-${d}`
  return { date, takenAt: `${date}T${p(h)}:${p(mi)}:${p(s)}` }
}

function parseWithTemplate(base: string, t: NameTemplate): ParsedScreenshotName | null {
  const m = t.re.exec(base)
  if (!m) return null
  const v: Partial<Record<Field, string>> = {}
  t.fields.forEach((f, i) => (v[f] = m[i + 1]))
  const s = stamp(v.year!, v.month!, v.day!, Number(v.hour ?? 0), Number(v.minute ?? 0), Number(v.second ?? 0))
  if (!s) return null
  return { origin: 'cleanshot', ...s, app: v.app?.trim() || null, window: v.window?.trim() || null }
}

/** `template` = CleanShot's own name template (compileNameTemplate); the built-in rules are tried after it. */
export function parseScreenshotName(filename: string, template?: NameTemplate | null): ParsedScreenshotName | null {
  const base = filename.replace(/^.*[\\/]/, '').replace(/\.[A-Za-z0-9]{2,5}$/, '').trim()
  if (template) {
    const p = parseWithTemplate(base, template)
    if (p) return p
  }
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
