import { describe, it, expect } from 'vitest'
import { appRuleLookup, appReadings, changeAppRule, storedAppRules, suggestionFor, withAppRule, MAX_APP_RULES } from '../src/main/sorter/app-rules'
import type { AppTally } from '../src/main/triage-apps'

const tally = (app: string, kept: number, thrownAway: number, undecided = 0): AppTally => ({ key: app.trim().toLowerCase(), app, kept, thrownAway, rows: { undecided, selected: 0, included: kept, excluded: thrownAway } })

describe('his per-app rules: what is stored', () => {
  it('reads only well-formed rules; one per app, compared without case or outer spaces', () => {
    expect(storedAppRules(undefined)).toEqual([])
    expect(storedAppRules('nonsense')).toEqual([])
    expect(storedAppRules([{ app: 'Brightloom', rule: 'keep' }, { app: ' brightLOOM ', rule: 'throwaway' }, { app: 'Quillpad', rule: 'sometimes' }, { app: 7, rule: 'keep' }, null, { app: '', rule: 'throwaway' }])).toEqual([
      { app: 'brightLOOM', rule: 'throwaway' },
      { app: '', rule: 'throwaway' }
    ])
  })

  it('set, change and remove a rule', () => {
    let rules = withAppRule([], 'Brightloom', 'throwaway')
    rules = withAppRule(rules, 'Quillpad', 'keep')
    expect(rules).toEqual([{ app: 'Brightloom', rule: 'throwaway' }, { app: 'Quillpad', rule: 'keep' }])
    rules = withAppRule(rules, ' BRIGHTLOOM', 'keep')
    expect(rules).toEqual([{ app: 'BRIGHTLOOM', rule: 'keep' }, { app: 'Quillpad', rule: 'keep' }])
    expect(withAppRule(rules, 'brightloom', null)).toEqual([{ app: 'Quillpad', rule: 'keep' }])
    const find = appRuleLookup(rules)
    expect(find('  quillpad ')).toEqual({ app: 'Quillpad', rule: 'keep' })
    expect(find('Other')).toBeNull()
  })

  it('changeAppRule stores only an app name and keep, throwaway or none; anything else is refused and nothing is saved', () => {
    let stored: unknown = [{ app: 'Brightloom', rule: 'keep' }]
    const saves: unknown[] = []
    const save = (r: unknown): void => { stored = r; saves.push(r) }
    expect(changeAppRule('Quillpad', 'throwaway', () => stored, save)).toEqual({ ok: true })
    expect(stored).toEqual([{ app: 'Brightloom', rule: 'keep' }, { app: 'Quillpad', rule: 'throwaway' }])
    expect(changeAppRule('Brightloom', null, () => stored, save).ok).toBe(true)
    expect(stored).toEqual([{ app: 'Quillpad', rule: 'throwaway' }])
    const n = saves.length
    for (const [app, rule] of [[7, 'keep'], ['Quillpad', 'always'], ['x'.repeat(201), 'keep'], ['Quillpad', undefined], [null, 'keep']] as Array<[unknown, unknown]>) {
      expect(changeAppRule(app, rule, () => stored, save).ok).toBe(false)
    }
    expect(saves.length).toBe(n)
    stored = Array.from({ length: MAX_APP_RULES }, (_, i) => ({ app: `App ${i}`, rule: 'keep' }))
    expect(changeAppRule('One more', 'keep', () => stored, save).ok).toBe(false)
    expect(changeAppRule('App 3', 'throwaway', () => stored, save).ok).toBe(true) // changing one that is there is fine
  })
})

describe('his per-app rules: suggestions', () => {
  it('needs 20 decisions from the app', () => {
    expect(suggestionFor({ kept: 0, thrownAway: 19, builtIn: null, rule: null })).toBeNull()
    expect(suggestionFor({ kept: 0, thrownAway: 20, builtIn: null, rule: null })).toMatchObject({ kind: 'make', rule: 'throwaway', against: null })
  })

  it('needs 85% one way', () => {
    expect(suggestionFor({ kept: 16, thrownAway: 84, builtIn: null, rule: null })).toBeNull() // 84%
    expect(suggestionFor({ kept: 3, thrownAway: 17, builtIn: null, rule: null })).toMatchObject({ kind: 'make', rule: 'throwaway' }) // exactly 85%
    expect(suggestionFor({ kept: 17, thrownAway: 3, builtIn: null, rule: null })).toMatchObject({ kind: 'make', rule: 'keep' })
    expect(suggestionFor({ kept: 10, thrownAway: 10, builtIn: null, rule: null })).toBeNull()
  })

  it('none when the rule in force already says that; change when it says the opposite', () => {
    expect(suggestionFor({ kept: 1, thrownAway: 30, builtIn: 'throwaway', rule: null })).toBeNull()
    expect(suggestionFor({ kept: 1, thrownAway: 30, builtIn: 'keep', rule: 'throwaway' })).toBeNull() // his rule is the one in force
    expect(suggestionFor({ kept: 2, thrownAway: 19, builtIn: 'keep', rule: null })).toMatchObject({ kind: 'change', rule: 'throwaway', against: 'built-in', text: 'Built-in rule says keep, but you threw away 90% — change to Usually throw away?', action: 'Change rule' })
    expect(suggestionFor({ kept: 30, thrownAway: 1, builtIn: 'keep', rule: 'throwaway' })).toMatchObject({ kind: 'change', rule: 'keep', against: 'yours', text: 'Your rule says throw away, but you kept 97% — change to Usually keep?' })
    expect(suggestionFor({ kept: 3, thrownAway: 47, builtIn: null, rule: null })).toMatchObject({ text: 'You threw away 94% — make it a rule?', action: 'Make rule', share: 0.94 })
  })
})

describe('his per-app rules: the table', () => {
  it('one row per app with his counts, the built-in rule for the app name, his rule and the suggestion; "App not known" last', () => {
    const rows = appReadings([tally('', 28, 60, 305), tally('Brightloom', 3, 47, 97), tally('Finder', 1, 118, 74), tally('Claude', 2, 19, 60), tally('Quillpad', 40, 11, 412)], [{ app: 'quillpad', rule: 'keep' }, { app: 'Gone App', rule: 'throwaway' }])
    expect(rows.map((r) => r.app)).toEqual(['Quillpad', 'Finder', 'Brightloom', 'Claude', 'Gone App', ''])
    expect(rows[0]).toEqual({ app: 'Quillpad', kept: 40, keptShare: 40 / 51, thrownAway: 11, undecided: 412, builtIn: null, rule: 'keep', suggestion: null })
    expect(rows[1]).toMatchObject({ builtIn: 'throwaway', rule: null, suggestion: null })
    expect(rows[2].suggestion).toMatchObject({ kind: 'make', rule: 'throwaway' })
    expect(rows[3]).toMatchObject({ builtIn: 'keep', suggestion: { kind: 'change', rule: 'throwaway', against: 'built-in' } })
    // a rule of his for an app with nothing in the index is still listed, so it can be seen and removed
    expect(rows[4]).toEqual({ app: 'Gone App', kept: 0, keptShare: null, thrownAway: 0, undecided: 0, builtIn: null, rule: 'throwaway', suggestion: null })
    expect(rows[5]).toMatchObject({ app: '', kept: 28, thrownAway: 60, undecided: 305 })
  })
})
