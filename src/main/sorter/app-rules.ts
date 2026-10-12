/**
 * His per-app rules (ticket 20): for an app name, "usually keep", "usually throw away" or none.
 *
 * They live in the app config (index.ts `sorterAppRules`), never in the rebuildable index. A rule
 * leans the sorter like a built-in app rule (rules.ts applyRules takes the lookup made here) and takes
 * the place of the built-in rule for that app. Setting one sorts nothing: the next sort uses it.
 *
 * Also here: the reading for the "What the sorter goes by" table (his choices per app, the built-in
 * rule that fires on the app name, his rule, and a suggestion when his choices are lopsided), and the
 * built-in rules in words. Everything but goesBy() is pure.
 */
import type { SorterAppReading, SorterAppSuggestion, SorterGoesBy } from '../../preload'
import { appKey } from '../triage-logic'
import { byAppName, readAppTallies, type AppTally } from '../triage-apps'
import { builtInForApp, builtInRules, type AppRuleLookup, type Lean } from './rules'

export type AppRule = { app: string; rule: Lean }

export const MAX_APP_RULES = 500
export const MAX_APP_NAME = 200
/** A suggestion needs this many decisions of his from the app, and this share of them going one way. */
export const SUGGEST_MIN_DECIDED = 20
export const SUGGEST_MIN_PERCENT = 85

const isLean = (x: unknown): x is Lean => x === 'keep' || x === 'throwaway'
const isName = (x: unknown): x is string => typeof x === 'string' && x.length <= MAX_APP_NAME

/** The rules as stored in config: anything that is not a rule is left out; a later rule for the same app replaces an earlier one. */
export function storedAppRules(raw: unknown): AppRule[] {
  if (!Array.isArray(raw)) return []
  let out: AppRule[] = []
  for (const r of raw.slice(0, MAX_APP_RULES * 2)) {
    if (!r || typeof r !== 'object') continue
    const { app, rule } = r as Record<string, unknown>
    if (isName(app) && isLean(rule)) out = withAppRule(out, app, rule)
  }
  return out.slice(0, MAX_APP_RULES)
}

/** The list with this app's rule set (in the place of the one it had), or removed (null). '' = app not known. */
export function withAppRule(rules: AppRule[], app: string, rule: Lean | null): AppRule[] {
  const key = appKey(app)
  const at = rules.findIndex((r) => appKey(r.app) === key)
  if (!rule) return rules.filter((_, i) => i !== at)
  const next = { app: app.trim(), rule }
  return at < 0 ? [...rules, next] : rules.map((r, i) => (i === at ? next : r))
}

/** His rule for an app name, for rules.ts applyRules. */
export function appRuleLookup(rules: AppRule[]): AppRuleLookup {
  const by = new Map(rules.map((r) => [appKey(r.app), r]))
  return (app) => by.get(appKey(app)) ?? null
}

/**
 * A rule set from the renderer. Only an app name with keep, throwaway or null (none) is stored;
 * anything else is refused and what is stored stays as it was.
 */
export function changeAppRule(app: unknown, rule: unknown, current: () => unknown, save: (rules: AppRule[]) => void): { ok: boolean; error?: string } {
  if (!isName(app) || !(rule === null || isLean(rule))) return { ok: false, error: 'That is not a rule the sorter knows.' }
  const before = storedAppRules(current())
  const next = withAppRule(before, app, rule)
  if (next.length > MAX_APP_RULES) return { ok: false, error: `There are already ${MAX_APP_RULES} rules; remove one first.` }
  save(next)
  return { ok: true }
}

const WORDS: Record<Lean, { says: string; did: string; control: string }> = {
  keep: { says: 'keep', did: 'kept', control: 'Usually keep' },
  throwaway: { says: 'throw away', did: 'threw away', control: 'Usually throw away' }
}

/**
 * A suggestion for one app: he has decided at least SUGGEST_MIN_DECIDED from it, SUGGEST_MIN_PERCENT
 * or more went one way, and the rule in force (his, else the built-in one) does not already say that.
 * With no rule in force: make one. With a rule saying the opposite: change it.
 */
export function suggestionFor(a: { kept: number; thrownAway: number; builtIn: Lean | null; rule: Lean | null }): SorterAppSuggestion | null {
  const decided = a.kept + a.thrownAway
  if (decided < SUGGEST_MIN_DECIDED) return null
  const way: Lean = a.kept >= a.thrownAway ? 'keep' : 'throwaway'
  const most = Math.max(a.kept, a.thrownAway)
  if (most * 100 < SUGGEST_MIN_PERCENT * decided) return null // whole numbers: 85% exactly counts
  const inForce = a.rule ?? a.builtIn
  if (inForce === way) return null
  const share = most / decided
  const did = `you ${WORDS[way].did} ${Math.round(share * 100)}%`
  if (!inForce) return { kind: 'make', rule: way, share, against: null, text: `${did[0].toUpperCase()}${did.slice(1)} — make it a rule?`, action: 'Make rule' }
  const against = a.rule ? 'yours' : 'built-in'
  return { kind: 'change', rule: way, share, against, text: `${a.rule ? 'Your rule' : 'Built-in rule'} says ${WORDS[inForce].says}, but ${did} — change to ${WORDS[way].control}?`, action: 'Change rule' }
}

/**
 * The table: one row per app in the index, plus any app he has a rule for that is not there. Most
 * screenshots first, "app not known" last.
 */
export function appReadings(tallies: AppTally[], rules: AppRule[]): SorterAppReading[] {
  const mine = appRuleLookup(rules)
  const seen = new Set(tallies.map((t) => t.key))
  const blank = (r: AppRule): AppTally => ({ key: appKey(r.app), app: r.app, kept: 0, thrownAway: 0, rows: { undecided: 0, selected: 0, included: 0, excluded: 0 } })
  const all = [...tallies, ...rules.filter((r) => !seen.has(appKey(r.app))).map(blank)]
  const size = (r: SorterAppReading): number => r.kept + r.thrownAway + r.undecided
  return all
    .map((t): SorterAppReading => {
      const builtIn = t.key ? builtInForApp(t.app) : null
      const rule = mine(t.key)?.rule ?? null
      const decided = t.kept + t.thrownAway
      return { app: t.app, kept: t.kept, keptShare: decided ? t.kept / decided : null, thrownAway: t.thrownAway, undecided: t.rows.undecided, builtIn, rule, suggestion: suggestionFor({ kept: t.kept, thrownAway: t.thrownAway, builtIn, rule }) }
    })
    .sort((a, b) => (a.app === '' ? 1 : 0) - (b.app === '' ? 1 : 0) || size(b) - size(a) || byAppName(a, b))
}

/** "What the sorter goes by": the table and the built-in rules in words, usually kept and usually throwaway. */
export function goesBy(wellRoot: string, storedRules: unknown, now = Date.now()): SorterGoesBy {
  const builtIn = builtInRules()
  return {
    apps: appReadings(readAppTallies(wellRoot, now), storedAppRules(storedRules)),
    builtIn: { keep: builtIn.filter((r) => r.lean === 'keep').map((r) => r.title), throwaway: builtIn.filter((r) => r.lean === 'throwaway').map((r) => r.title) }
  }
}
