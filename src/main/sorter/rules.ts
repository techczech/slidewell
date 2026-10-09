/**
 * Sorter step 1: rules over what is known about a screenshot without looking at the picture: the app
 * and window title (parsed from CleanShot names, often empty) and the OCR text. A rule only *leans*:
 * it proposes keep or throwaway with a confidence and a reason in plain words. decide.ts turns the
 * lean (plus the classifier) into keep / throwaway / doubtful under the keep-bias thresholds.
 *
 * Pure: no Electron, no files. When a keep rule and a throwaway rule both fit, keep wins (when
 * unsure, keep). Spec: presentation-system 2026-10-09 screenshots-and-talkweaver, part B.
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

type Ctx = { app: string; title: string; ocr: string; words: number }
type Rule = { name: string; lean: Lean; test: (c: Ctx) => { confidence: number; reason: string } | null }

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
    name: 'own-apps',
    lean: 'keep',
    test: (c) => {
      if (has(c.app, OWN_APPS) || has(c.title, OWN_APPS)) return { confidence: 0.85, reason: 'TalkWeaver, WriteFlex or SlideWell screen — usually kept' }
      if (has(c.ocr, OWN_APPS)) return { confidence: 0.7, reason: 'Mentions TalkWeaver, WriteFlex or SlideWell — usually kept' }
      return null
    }
  },
  {
    name: 'ai-answer',
    lean: 'keep',
    test: (c) => {
      if (has(c.app, AI_APPS) || has(c.title, AI_APPS)) return { confidence: 0.8, reason: 'Claude or ChatGPT answer — usually kept' }
      if (has(c.ocr, AI_OCR)) return { confidence: 0.75, reason: 'Looks like a Claude or ChatGPT answer — usually kept' }
      return null
    }
  },
  {
    name: 'slides',
    lean: 'keep',
    test: (c) => (has(c.app, SLIDE_APPS) || has(c.title, SLIDE_APPS) ? { confidence: 0.7, reason: 'Slides on screen — usually kept' } : null)
  },
  {
    name: 'chart',
    lean: 'keep',
    test: (c) => {
      const s = chartScore(c.ocr, c.words)
      return s ? { confidence: s, reason: 'Looks like a chart — usually kept' } : null
    }
  },
  // --- throwaway-leaning ---
  {
    name: 'terminal',
    lean: 'throwaway',
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
    test: (c) => {
      if (/^finder$/i.test(c.app.trim())) return { confidence: 0.8, reason: 'Finder window — usually throwaway' }
      const cols = countMatches(c.ocr, FINDER_COLUMNS)
      const side = countMatches(c.ocr, FINDER_SIDEBAR)
      if (cols >= 2 && side >= 2) return { confidence: 0.7, reason: 'Looks like a Finder file list — usually throwaway' }
      return null
    }
  }
]

/** The best-fitting rule's lean, or null when no rule fits. Keep beats throwaway when both fit. */
export function applyRules(f: ShotFacts): RuleVerdict | null {
  const ocr = (f.ocrText ?? '').trim()
  const ctx: Ctx = { app: (f.app ?? '').trim(), title: (f.windowTitle ?? '').trim(), ocr, words: ocr ? ocr.split(/\s+/).length : 0 }
  let best: RuleVerdict | null = null
  let bestKeep: RuleVerdict | null = null
  for (const r of RULES) {
    const hit = r.test(ctx)
    if (!hit) continue
    const v: RuleVerdict = { lean: r.lean, confidence: hit.confidence, reason: hit.reason, rule: r.name }
    if (r.lean === 'keep' && (!bestKeep || v.confidence > bestKeep.confidence)) bestKeep = v
    if (!best || v.confidence > best.confidence) best = v
  }
  // when unsure, keep: any keep rule outranks every throwaway rule
  return bestKeep ?? best
}
