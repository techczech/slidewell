/**
 * Sorter step 1: rules over what is known about a screenshot without looking at the picture: the app
 * and window title (parsed from CleanShot names, often empty) and the OCR text. A rule only *leans*:
 * it proposes keep or throwaway with a confidence and a reason in plain words. decide.ts turns the
 * lean (plus the classifier) into keep / throwaway / doubtful under the keep-bias thresholds.
 *
 * Pure: no Electron, no files. When a keep rule and a throwaway rule both fit, keep wins (when
 * unsure, keep). Spec: presentation-system 2026-10-09 screenshots-and-talkweaver, part B.
 *
 * His own per-app rules (ticket 20; app-rules.ts keeps them, in the app config): a rule he set for an
 * app takes the place of every built-in rule that goes by the app (its name or window title) for that
 * screenshot. Built-in rules that go by the text or the look still apply beside it, and it leans with
 * the strength of the built-in app rules; it never decides alone.
 */

export type ShotFacts = {
  app?: string
  windowTitle?: string
  ocrText?: string
  filename?: string
}

export type Lean = 'keep' | 'throwaway'

export type RuleVerdict = {
  lean: Lean
  /** How sure the rule is of its lean, 0.5..1. */
  confidence: number
  /** Plain words for the review card, e.g. "Terminal window with a short error — usually throwaway". */
  reason: string
  /** Stable rule name, stored with the proposal. */
  rule: string
}

/** His rule for an app name, if he set one (app-rules.ts appRuleLookup). `app` is the name as he will read it. */
export type AppRuleLookup = (app: string) => { app: string; rule: Lean } | null

/** Stored as the rule name of a proposal his rule leaned. */
export const YOUR_RULE = 'your-rule'
/** The strength of his rule: that of the surest built-in app rules. */
export const APP_RULE_CONFIDENCE = 0.85
export const APP_NOT_KNOWN = 'App not known'

type Ctx = { app: string; title: string; ocr: string; words: number }
type Rule = { name: string; lean: Lean; /** The rule in words, for the list of built-in rules. */ title: string; test: (c: Ctx) => { confidence: number; reason: string } | null }

const has = (s: string, re: RegExp): boolean => re.test(s)
const countMatches = (s: string, needles: string[]): number => needles.filter((n) => s.includes(n)).length

const TERMINAL_APPS = /\b(terminal|iterm2?|ghostty|warp|alacritty|kitty|wezterm|hyper)\b/i
const SHELL_TITLE = /(^|[\s—–-])(zsh|bash|fish|sh|ssh)\b|~\/|\bnpm\b|\bgit\b/i
const SHELL_OCR = /(\bzsh: |\bbash: |Last login: |command not found|\S+@\S+\s+\S*\s*[%$#]\s|^\s*[$%]\s+\S)/m
const ERROR_OCR = /\b(error|errors|ERR!|fatal|failed|failure|not found|denied|rejected|traceback|exception|ENOENT|EACCES|panic)\b/i

const SETTINGS_APPS = /\bsystem (settings|preferences)\b/i
const SETTINGS_PANES = ['Privacy & Security', 'Wi-Fi', 'Bluetooth', 'Screen Recording', 'Login Items', 'Notifications', 'Control Centre', 'Control Center', 'Desktop & Dock', 'Accessibility', 'Displays', 'Software Update', 'Battery', 'Lock Screen', 'Touch ID & Password']

const FINDER_COLUMNS = ['Date Modified', 'Date Added', 'Kind', 'Size']
const FINDER_SIDEBAR = ['Favourites', 'Favorites', 'AirDrop', 'Recents', 'Applications', 'Downloads', 'iCloud Drive', 'Locations']

const AI_APPS = /\b(claude|chatgpt)\b/i
const AI_OCR = /(ChatGPT can make mistakes|Claude can make mistakes|Claude is AI and can make mistakes|Reply to Claude|Message ChatGPT|Ask anything|How can I help you today)/i

const OWN_APPS = /\b(talk ?weaver|write ?flex|slide ?well)\b/i
const SLIDE_APPS = /\b(powerpoint|keynote|google slides)\b/i
const CHART_WORDS = /\b(chart|graph|figure|fig\.|axis|percent(age)?|source:|survey|respondents)\b/i

function chartScore(ocr: string, words: number): number {
  if (!ocr || words > 220) return 0
  const numbers = (ocr.match(/\b\d+([.,]\d+)?\s?%?/g) ?? []).length
  const percents = (ocr.match(/\d\s?%/g) ?? []).length
  const years = new Set(ocr.match(/\b(19[5-9]\d|20[0-4]\d)\b/g) ?? []).size
  if (numbers < 6) return 0
  if (has(ocr, CHART_WORDS) || percents >= 3 || years >= 3) return 0.65
  return 0
}

const RULES: Rule[] = [
  // --- keep-leaning ---
  {
    name: 'ai-answer',
    lean: 'keep',
    title: 'Claude or ChatGPT answer',
    test: (c) => {
      if (has(c.app, AI_APPS) || has(c.title, AI_APPS)) return { confidence: 0.8, reason: 'Claude or ChatGPT answer — usually kept' }
      if (has(c.ocr, AI_OCR)) return { confidence: 0.75, reason: 'Looks like a Claude or ChatGPT answer — usually kept' }
      return null
    }
  },
  {
    name: 'slides',
    lean: 'keep',
    title: 'Slides on screen',
    test: (c) => (has(c.app, SLIDE_APPS) || has(c.title, SLIDE_APPS) ? { confidence: 0.7, reason: 'Slides on screen — usually kept' } : null)
  },
  {
    name: 'chart',
    lean: 'keep',
    title: 'Looks like a chart',
    test: (c) => {
      const s = chartScore(c.ocr, c.words)
      return s ? { confidence: s, reason: 'Looks like a chart — usually kept' } : null
    }
  },
  // --- throwaway-leaning ---
  {
    // turned round 2026-10-13 (ticket 20): his own apps' screens are development leftovers far more often than not.
    // Only the app or window title counts; a mention in the text says nothing about the app.
    name: 'own-apps',
    lean: 'throwaway',
    title: 'TalkWeaver, WriteFlex or SlideWell screen',
    test: (c) => (has(c.app, OWN_APPS) || has(c.title, OWN_APPS) ? { confidence: 0.85, reason: 'TalkWeaver, WriteFlex or SlideWell screen — usually throwaway' } : null)
  },
  {
    name: 'terminal',
    lean: 'throwaway',
    title: 'Terminal window',
    test: (c) => {
      const shortError = c.words > 0 && c.words < 60 && has(c.ocr, ERROR_OCR)
      if (has(c.app, TERMINAL_APPS) || (c.app === '' && has(c.title, SHELL_TITLE) && has(c.ocr, SHELL_OCR))) {
        return shortError
          ? { confidence: 0.9, reason: 'Terminal window with a short error — usually throwaway' }
          : { confidence: 0.8, reason: 'Terminal window — usually throwaway' }
      }
      if (has(c.ocr, SHELL_OCR)) {
        return shortError
          ? { confidence: 0.75, reason: 'Looks like a terminal with a short error — usually throwaway' }
          : { confidence: 0.65, reason: 'Looks like a terminal window — usually throwaway' }
      }
      return null
    }
  },
  {
    name: 'system-settings',
    lean: 'throwaway',
    title: 'System Settings window',
    test: (c) => {
      if (has(c.app, SETTINGS_APPS)) return { confidence: 0.85, reason: 'System Settings window — usually throwaway' }
      const panes = countMatches(c.ocr, SETTINGS_PANES)
      if ((has(c.ocr, SETTINGS_APPS) && panes >= 1) || panes >= 3) return { confidence: 0.7, reason: 'Looks like System Settings — usually throwaway' }
      return null
    }
  },
  {
    name: 'finder',
    lean: 'throwaway',
    title: 'Finder window',
    test: (c) => {
      if (/^finder$/i.test(c.app.trim())) return { confidence: 0.8, reason: 'Finder window — usually throwaway' }
      const cols = countMatches(c.ocr, FINDER_COLUMNS)
      const side = countMatches(c.ocr, FINDER_SIDEBAR)
      if (cols >= 2 && side >= 2) return { confidence: 0.7, reason: 'Looks like a Finder file list — usually throwaway' }
      return null
    }
  }
]

/** The built-in rules in words, keep-leaning first, in the order they are tried. */
export function builtInRules(): Array<{ name: string; lean: Lean; title: string }> {
  return RULES.map((r) => ({ name: r.name, lean: r.lean, title: r.title }))
}

/** The lean of the built-in rule that fires on this app name alone (no title, no text), or null. */
export function builtInForApp(app: string): Lean | null {
  return applyRules({ app })?.lean ?? null
}

/** His rule as a reason: "Your rule: <App> — usually throwaway" / "— usually kept". */
export function yourRuleReason(app: string, lean: Lean): string {
  return `Your rule: ${app.trim() || APP_NOT_KNOWN} — usually ${lean === 'keep' ? 'kept' : 'throwaway'}`
}

/**
 * The best-fitting rule's lean, or null when no rule fits. Keep beats throwaway when both fit.
 * `mine` looks up his rule for the screenshot's app. When he has one, the built-in rules are tried
 * without the app name and window title, so only those that go by the text or the look can fire, and
 * his rule joins them as one more rule.
 */
export function applyRules(f: ShotFacts, mine?: AppRuleLookup | null): RuleVerdict | null {
  const ocr = (f.ocrText ?? '').trim()
  const app = (f.app ?? '').trim()
  const own = mine ? mine(app) : null
  const ctx: Ctx = { app: own ? '' : app, title: own ? '' : (f.windowTitle ?? '').trim(), ocr, words: ocr ? ocr.split(/\s+/).length : 0 }
  const fits: RuleVerdict[] = []
  if (own) fits.push({ lean: own.rule, confidence: APP_RULE_CONFIDENCE, reason: yourRuleReason(own.app, own.rule), rule: YOUR_RULE })
  for (const r of RULES) {
    const hit = r.test(ctx)
    if (hit) fits.push({ lean: r.lean, confidence: hit.confidence, reason: hit.reason, rule: r.name })
  }
  let best: RuleVerdict | null = null
  let bestKeep: RuleVerdict | null = null
  for (const v of fits) {
    if (v.lean === 'keep' && (!bestKeep || v.confidence > bestKeep.confidence)) bestKeep = v
    if (!best || v.confidence > best.confidence) best = v
  }
  // when unsure, keep: any keep rule outranks every throwaway rule
  return bestKeep ?? best
}
