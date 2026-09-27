import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ownerMatcher, defaultOwnerNames, resolveOwnerNames } from '../src/main/owners'
import { loadDeckMeta, setOwnerNames } from '../src/main/deckmeta'

// Author strings as they occur in the maintainer's own archive (presentation.json author /
// last_modified_by), with the old rule's verdict: contains "dominik" or "lukes", or is exactly "dl".
const MAINTAINER_MINE = ['Dominik Lukes', 'Dominik', 'Dominik Lukeš', 'Lukes, Dominik', 'dlukes', 'dominik.lukes@example.org', 'dl', 'DL']
const MAINTAINER_NOT = ['FUKSA Ivan', 'Alex', 'Dom', 'Sarah Jones', 'Kelly Webb-Davies', 'I.T Services', 'user', '']

const account = (fullName: string | null, username: string | null) => () => ({ fullName, username })

describe('defaultOwnerNames', () => {
  it('uses the account full name then the login name', () => {
    expect(defaultOwnerNames(account('Dominik Lukeš', 'dominiklukes'))).toEqual(['Dominik Lukeš', 'dominiklukes'])
  })
  it('degrades gracefully when the full name or the whole probe fails', () => {
    expect(defaultOwnerNames(account(null, 'jsmith'))).toEqual(['jsmith'])
    expect(defaultOwnerNames(() => { throw new Error('no id') })).toEqual([])
  })
})

describe('ownerMatcher — maintainer parity with the old dominik/lukes rule', () => {
  for (const [label, probe] of [
    ['id -F with diacritics', account('Dominik Lukeš', 'dominiklukes')],
    ['id -F without diacritics', account('Dominik Lukes', 'dominiklukes')]
  ] as const) {
    it(`default from the account (${label}) matches the same authors`, () => {
      const mine = ownerMatcher(resolveOwnerNames(undefined, probe).names)
      for (const a of MAINTAINER_MINE) expect(mine(a), a).toBe(true)
      for (const a of MAINTAINER_NOT) expect(mine(a), a).toBe(false)
    })
  }
})

describe('ownerMatcher — another user', () => {
  it('matches that user by name, surname-first, login and initials; not the maintainer', () => {
    const mine = ownerMatcher(resolveOwnerNames(undefined, account('Jane Smith', 'jsmith')).names)
    for (const a of ['Jane Smith', 'Smith, Jane', 'jsmith', 'JS', 'jane.smith@example.org']) expect(mine(a), a).toBe(true)
    for (const a of ['Dominik Lukes', 'dlukes', 'dl', 'Alex']) expect(mine(a), a).toBe(false)
  })
  it('a configured list overrides the account default', () => {
    const r = resolveOwnerNames([' Jane Smith ', '', 'JANE SMITH', 'jsm'], account('Dominik Lukes', 'dominiklukes'))
    expect(r).toEqual({ names: ['Jane Smith', 'jsm'], isDefault: false })
    expect(resolveOwnerNames([], account('Dominik Lukes', 'dominiklukes')).isDefault).toBe(true)
  })
})

describe('loadDeckMeta ownership follows the owner names', () => {
  const work = mkdtempSync(join(tmpdir(), 'sw-owners-'))
  afterAll(() => rmSync(work, { recursive: true, force: true }))
  const deck = (id: string, metadata: Record<string, string>): void => {
    mkdirSync(join(work, 'archive', 'extracted', id), { recursive: true })
    writeFileSync(join(work, 'archive', 'extracted', id, 'presentation.json'), JSON.stringify({ metadata }))
  }
  deck('mine', { author: 'Lukes, Dominik', ownership: 'mine' })
  deck('jane', { author: 'Jane Smith', ownership: 'others' }) // stamped by the pipeline's hardcoded names
  deck('blank', { ownership: 'unknown' })

  it('recomputes from the author, rescanning (and re-keying the disk cache) when the names change', () => {
    const archive = join(work, 'archive')
    setOwnerNames(['Dominik Lukes', 'dominiklukes'])
    let idx = loadDeckMeta(archive, join(work, 'cache'))
    expect([idx.mine.ownership, idx.jane.ownership, idx.blank.ownership]).toEqual(['mine', 'others', 'unknown'])
    setOwnerNames(['Jane Smith'])
    idx = loadDeckMeta(archive, join(work, 'cache'))
    expect([idx.mine.ownership, idx.jane.ownership, idx.blank.ownership]).toEqual(['others', 'mine', 'unknown'])
  })
})
