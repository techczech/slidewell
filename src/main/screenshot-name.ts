/**
 * Pure parser for screenshot file names (capture inbox). NO electron/fs imports, so it is unit-testable
 * in vitest. Recognises:
 *  - names built from CleanShot's own `mediaNameTemplate` preference (ticket 15), compiled once with
 *    `compileNameTemplate` and passed in. Dominik's template gives
 *    `CleanShot 2026-10-10 at 1147from <app> with <window>.png`;
 *  - CleanShot's default style (`CleanShot 2026-10-08 at 10.39.03@2x.png`, also `at 0801 from <app> with <window>`);
 *  - macOS names (`Screenshot 2026-10-08 at 10.05.01.png`, `Screen Shot … 10.05.01 AM`).
 * Anything else returns null — the Desktop source uses that to ignore files that are not screenshots.
 *
 * Matching cost is bounded: a template compiles only from known tokens, each at most once, with a
 * literal between the two free-text fields (app, window), so the pattern has at most two lazy groups
 * between exact literals; names longer than 255 characters (the file-system limit) are not parsed.
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
export type NameTemplate = {
  readonly re: RegExp
  readonly fields: readonly Field[]
  readonly parts: readonly string[]
  /** The name ends in a free-text field (window title): a trailing number may belong to it. */
  readonly endsWithText: boolean
  /** The last literal ends in whitespace before that field; CleanShot trims it when the field is empty. */
  readonly trimmedTail: boolean
}

/** Extra context for one name. `siblings` = lower-case file names in the same folder listing. */
export type ParseContext = { siblings?: ReadonlySet<string> }

export const MAX_NAME_LENGTH = 255

const CLEANSHOT =
  /^CleanShot (\d{4})-(\d{2})-(\d{2}) at (\d{2})[.:]?(\d{2})(?:[.:]?(\d{2}))?(?:@\d+x)?(?: ?from (.+?))?(?: with ?(.*))?$/
const MACOS = /^Screen ?[Ss]hot (\d{4})-(\d{2})-(\d{2}) at (\d{1,2})\.(\d{2})\.(\d{2})(?:[\s ]*([AaPp][Mm]))?(?: \(\d+\))?$/
// Finder / CleanShot duplicate counter at the very end: `name 2`, `name (2)`
const DUPLICATE = /^(.*\S)(?: \d+| \(\d+\))$/

// CleanShot template tokens. Any other `%x` makes the template unusable (it is not guessed at).
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
const TEXT_FIELDS = new Set<Field>(['app', 'window'])
const RETINA = '(?:@\\d+x)?'
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Compile CleanShot's `mediaNameTemplate` (the array of literal and `%x` parts). Returns null — and the
 * built-in patterns are used instead — unless the template:
 *  - starts with a literal word of at least three letters before its first field (e.g. "CleanShot"),
 *    so a bare date such as `2026-10-10 holiday.png` is never taken for a screenshot;
 *  - has a full date (year, month, day);
 *  - uses only known tokens, each once, with a literal between the app and window fields.
 */
export function compileNameTemplate(parts: readonly string[] | null | undefined): NameTemplate | null {
  if (!parts || parts.length === 0) return null
  const pieces: string[] = []
  for (const part of parts) for (const piece of String(part).split(/(%[A-Za-z])/)) if (piece) pieces.push(piece)
  const isToken = (p: string): boolean => /^%[A-Za-z]$/.test(p)
  const firstToken = pieces.findIndex(isToken)
  if (firstToken < 0 || !/\p{L}{3,}/u.test(pieces.slice(0, firstToken).join(''))) return null
  const fields: Field[] = []
  let re = '^'
  let lastWasText = false
  for (const piece of pieces) {
    if (isToken(piece)) {
      const t = TOKEN[piece[1]]
      if (!t || fields.includes(t.field)) return null
      if (TEXT_FIELDS.has(t.field) && lastWasText) return null
      fields.push(t.field)
      re += t.re
      if (t.field === 'hour' || t.field === 'minute' || t.field === 'second') re += RETINA
      lastWasText = TEXT_FIELDS.has(t.field)
    } else {
      re += escapeRe(piece)
      lastWasText = false
    }
  }
  if (!fields.includes('year') || !fields.includes('month') || !fields.includes('day')) return null
  const last = pieces[pieces.length - 1]
  const endsWithText = isToken(last) && TEXT_FIELDS.has(TOKEN[last[1]]!.field)
  const beforeLast = pieces[pieces.length - 2] ?? ''
  re += `${RETINA}$`
  return { re: new RegExp(re, 'u'), fields, parts: [...parts], endsWithText, trimmedTail: endsWithText && !isToken(beforeLast) && /\s$/.test(beforeLast) }
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

function matchTemplate(base: string, t: NameTemplate): ParsedScreenshotName | null {
  let m = t.re.exec(base)
  if (!m && t.trimmedTail) m = t.re.exec(`${base} `) // `… with.png`: CleanShot trimmed the space before an empty title
  if (!m) return null
  const v: Partial<Record<Field, string>> = {}
  t.fields.forEach((f, i) => (v[f] = m![i + 1]))
  const s = stamp(v.year!, v.month!, v.day!, Number(v.hour ?? 0), Number(v.minute ?? 0), Number(v.second ?? 0))
  if (!s) return null
  return { origin: 'cleanshot', ...s, app: v.app?.trim() || null, window: v.window?.trim() || null }
}

/**
 * A trailing ` 2` / ` (2)` is a duplicate counter only when it cannot be part of the window title (the
 * template does not end in text), or when the same name without it is in the folder listing.
 * Otherwise the digits stay: `… with Quarterly results 2026` keeps its year.
 */
function parseWithTemplate(base: string, ext: string, t: NameTemplate, ctx: ParseContext): ParsedScreenshotName | null {
  const dup = DUPLICATE.exec(base)
  if (dup && t.endsWithText && ctx.siblings?.has(`${dup[1]}${ext}`.toLowerCase())) {
    const p = matchTemplate(dup[1], t)
    if (p) return p
  }
  const p = matchTemplate(base, t)
  if (p || !dup || t.endsWithText) return p
  return matchTemplate(dup[1], t)
}

function parseBuiltIn(base: string): ParsedScreenshotName | null {
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

/** `template` = CleanShot's own name template (compileNameTemplate); the built-in rules are tried after it. */
export function parseScreenshotName(filename: string, template?: NameTemplate | null, ctx: ParseContext = {}): ParsedScreenshotName | null {
  const name = filename.replace(/^.*[\\/]/, '')
  if (name.length > MAX_NAME_LENGTH) return null
  const ext = /\.[A-Za-z0-9]{2,5}$/.exec(name)?.[0] ?? ''
  const base = name.slice(0, name.length - ext.length).trim()
  if (template) {
    const p = parseWithTemplate(base, ext, template, ctx)
    if (p) return p
  }
  const p = parseBuiltIn(base)
  if (p) return p
  // a duplicate of a default-style name (`… at 10.39.03 2.png`): no free text at the end, so the counter is unambiguous
  const dup = DUPLICATE.exec(base)
  return dup && !/ with ?/.test(dup[1]) && !/ ?from /.test(dup[1]) ? parseBuiltIn(dup[1]) : null
}
