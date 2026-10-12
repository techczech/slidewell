import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listTriage } from '../src/main/triage'
import { appCounts, cleanAppList, decideAllFromApps, readAppTallies } from '../src/main/triage-apps'
import { appKey } from '../src/main/triage-logic'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-13T09:00:00Z')
let well: string
let src: string

// Invented apps. Rows: [hash, app, window title, text, his decision]
const ROWS: Array<[string, string, string, string, string | null]> = [
  ['b1', 'Brightloom', 'Canvas one', 'red arrow about the build', null],
  ['b2', 'Brightloom', 'Canvas two', 'plain page', null],
  ['b3', 'brightloom ', 'Canvas three', 'another arrow', null],
  ['b4', 'Brightloom', 'Canvas four', 'kept page', 'included'],
  ['b5', 'BRIGHTLOOM', 'Canvas five', 'binned page', 'excluded'],
  ['q1', 'Quillpad', 'Draft', 'red arrow in a draft', null],
  ['q2', 'Quillpad', 'Draft', 'staged', 'selected'],
  ['u1', '', '', 'no app in the name, an arrow', null],
  ['u2', '', '', 'no app, binned', 'excluded'],
  ['m1', 'Mossgrid', 'Board', 'emptied long ago', 'emptied'],
  ['m2', 'Mossgrid', 'Board', 'in the Bin by the sorter', null]
]

function db(): DatabaseSync {
  return new DatabaseSync(join(well, 'triage.db'))
}
const decisions = (): Record<string, string> => {
  const d = db()
  try {
    return Object.fromEntries((d.prepare('SELECT hash, state FROM triage_decisions ORDER BY hash').all() as Array<{ hash: string; state: string }>).map((r) => [r.hash, r.state]))
  } finally {
    d.close()
  }
}

beforeEach(() => {
  well = mkdtempSync(join(tmpdir(), 'sw-triage-apps-'))
  src = join(well, 'source')
  mkdirSync(src)
  const t = db()
  t.exec(`CREATE VIRTUAL TABLE triage_fts USING fts5(hash UNINDEXED, kind UNINDEXED, rel_path UNINDEXED, filename, ext UNINDEXED, size UNINDEXED, mtime UNINDEXED,
            poster_rel UNINDEXED, offline UNINDEXED, ocr_text, scanned_at UNINDEXED, source UNINDEXED, taken_at UNINDEXED, app, window_title);
          CREATE TABLE triage_decisions (hash TEXT PRIMARY KEY, state TEXT NOT NULL, decided_at TEXT, well_id TEXT);
          CREATE TABLE sorter_proposals (hash TEXT PRIMARY KEY, proposal TEXT NOT NULL, confidence REAL NOT NULL, p_keep REAL NOT NULL, reason TEXT NOT NULL, rule TEXT, sorter_version TEXT NOT NULL,
            model_id TEXT, proposed_at TEXT NOT NULL, throwaway_since TEXT, answered_at TEXT, answer TEXT, decided_by TEXT, decided_model TEXT);`)
  const row = t.prepare("INSERT INTO triage_fts (hash, kind, rel_path, filename, ext, size, mtime, poster_rel, offline, ocr_text, scanned_at, source, taken_at, app, window_title) VALUES (?, 'image', ?, ?, 'png', '64', ?, '', '0', ?, ?, ?, '', ?, ?)")
  const dec = t.prepare('INSERT INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, ?, ?, NULL)')
  ROWS.forEach(([hash, app, title, text, state], i) => {
    writeFileSync(join(src, `${hash}.png`), Buffer.alloc(64, i + 1))
    row.run(hash, `${hash}.png`, `${hash}.png`, String(NOW - i * 1000), text, new Date(NOW - i * 1000).toISOString(), src, app, title)
    if (state) dec.run(hash, state, '2026-10-01T00:00:00Z')
  })
  // the same picture saved twice from Brightloom: one decision key, two rows
  row.run('b1', 'copy/b1.png', 'b1 copy.png', String(NOW - 50_000), 'red arrow about the build', new Date(NOW - 50_000).toISOString(), src, 'Brightloom', 'Canvas one')
  // m2: the sorter called it throwaway 40 days ago, so it sits in the review Bin and no list shows it
  const old = new Date(NOW - 40 * DAY).toISOString()
  t.prepare("INSERT INTO sorter_proposals (hash, proposal, confidence, p_keep, reason, sorter_version, proposed_at, throwaway_since) VALUES ('m2', 'throwaway', 0.95, 0.05, 'old', 'test', ?, ?)").run(old, old)
  t.close()
})
afterEach(() => rmSync(well, { recursive: true, force: true }))

describe('app names', () => {
  it('compare without case or outer spaces', () => {
    expect(appKey(' BrightLoom ')).toBe('brightloom')
    expect(appKey(null)).toBe('')
  })
  it('an app list from the renderer: strings only, capped', () => {
    expect(cleanAppList(['Brightloom', ''])).toEqual(['Brightloom', ''])
    expect(cleanAppList('Brightloom')).toBeNull()
    expect(cleanAppList(['ok', 7])).toBeNull()
    expect(cleanAppList(['x'.repeat(201)])).toBeNull()
    expect(cleanAppList(Array.from({ length: 201 }, (_, i) => `a${i}`))).toBeNull()
  })
})

describe('Triage list: app filter', () => {
  const hashes = async (q: string, state: string, apps: string[] | null, limit = 150, offset = 0, sort: 'scanned' | 'date-desc' | 'date-asc' = 'scanned'): Promise<string[]> =>
    (await listTriage(well, q, state, sort, limit, offset, NOW, apps)).map((r) => r.hash)

  it('no filter lists as before', async () => {
    expect((await hashes('', 'undecided', null)).sort()).toEqual(['b1', 'b1', 'b2', 'b3', 'q1', 'u1'])
    expect((await hashes('', 'undecided', [])).sort()).toEqual(['b1', 'b1', 'b2', 'b3', 'q1', 'u1'])
  })

  it('one app, whatever its spelling; several apps; the unknown bucket', async () => {
    expect((await hashes('', 'undecided', ['brightloom'])).sort()).toEqual(['b1', 'b1', 'b2', 'b3'])
    expect((await hashes('', 'undecided', ['Quillpad', ''])).sort()).toEqual(['q1', 'u1'])
    expect(await hashes('', 'undecided', [''])).toEqual(['u1'])
    expect(await hashes('', 'undecided', ['Nowhere'])).toEqual([])
  })

  it('works with the state tab, the text search, the sort and paging', async () => {
    expect((await hashes('', 'excluded', ['Brightloom', ''])).sort()).toEqual(['b5', 'u2'])
    expect((await hashes('', 'all', ['Brightloom'])).sort()).toEqual(['b1', 'b1', 'b2', 'b3', 'b4', 'b5'])
    expect((await hashes('arrow', 'undecided', ['Brightloom'])).sort()).toEqual(['b1', 'b1', 'b3'])
    expect((await hashes('arrow', 'undecided', ['Quillpad', ''])).sort()).toEqual(['q1', 'u1'])
    expect(await hashes('', 'undecided', ['Brightloom'], 150, 0, 'date-asc')).toEqual(['b1', 'b3', 'b2', 'b1'])
    const first = await hashes('', 'undecided', ['Brightloom'], 3, 0, 'date-desc')
    const second = await hashes('', 'undecided', ['Brightloom'], 3, 3, 'date-desc')
    expect(first).toEqual(['b1', 'b2', 'b3'])
    expect(second).toEqual(['b1'])
    // an app in the Bin or emptied stays hidden with a filter too
    expect(await hashes('', 'all', ['Mossgrid'])).toEqual([])
  })
})

describe('apps for the menu and the table', () => {
  it('each app with its count for the tab and its kept share from his decisions; most common spelling; unknown last', () => {
    expect(appCounts(well, 'undecided', NOW)).toEqual([
      { app: 'Brightloom', count: 4, kept: 1, thrownAway: 1, keptShare: 0.5 },
      { app: 'Quillpad', count: 1, kept: 1, thrownAway: 0, keptShare: 1 },
      { app: '', count: 1, kept: 0, thrownAway: 1, keptShare: 0 }
    ])
    expect(appCounts(well, 'excluded', NOW).map((a) => [a.app, a.count])).toEqual([['Brightloom', 1], ['', 1]])
    expect(appCounts(well, 'all', NOW).map((a) => [a.app, a.count])).toEqual([['Brightloom', 6], ['Quillpad', 2], ['', 2]])
  })

  it('tallies: his decisions per app by picture, rows per state as the lists show them', () => {
    const t = Object.fromEntries(readAppTallies(well, NOW).map((x) => [x.key, x]))
    expect(t.brightloom).toMatchObject({ app: 'Brightloom', kept: 1, thrownAway: 1, rows: { undecided: 4, selected: 0, included: 1, excluded: 1 } })
    expect(t.quillpad).toMatchObject({ kept: 1, thrownAway: 0, rows: { undecided: 1, selected: 1 } })
    expect(t.mossgrid).toMatchObject({ kept: 0, thrownAway: 0, rows: { undecided: 0 } })
  })

  it('no index yet: nothing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'sw-triage-apps-empty-'))
    try {
      expect(appCounts(empty, 'undecided', NOW)).toEqual([])
      expect(readdirSync(empty)).toEqual([])
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('bulk decide from an app filter', () => {
  it('excludes every undecided screenshot from the ticked apps and nothing else', () => {
    const before = decisions()
    const files = readdirSync(src).map((f) => `${f}:${statSync(join(src, f)).mtimeMs}`)
    const r = decideAllFromApps(well, ['brightloom'], 'exclude', 4, NOW)
    expect(r).toEqual({ ok: true, changed: 4, count: 4 })
    expect(decisions()).toEqual({ ...before, b1: 'excluded', b2: 'excluded', b3: 'excluded' })
    expect(readdirSync(src).map((f) => `${f}:${statSync(join(src, f)).mtimeMs}`)).toEqual(files) // no file touched
    const d = db()
    expect((d.prepare("SELECT decided_at FROM triage_decisions WHERE hash = 'b2'").get() as { decided_at: string }).decided_at).toBe(new Date(NOW).toISOString())
    d.close()
    expect(appCounts(well, 'undecided', NOW).map((a) => a.app)).toEqual(['Quillpad', ''])
  })

  it('select all, several apps with the unknown bucket', () => {
    expect(decideAllFromApps(well, ['Quillpad', ''], 'select', 2, NOW)).toEqual({ ok: true, changed: 2, count: 2 })
    expect(decisions()).toMatchObject({ q1: 'selected', u1: 'selected', q2: 'selected', u2: 'excluded' })
  })

  it('a count that differs from the one he was shown refuses and changes nothing', () => {
    const before = decisions()
    expect(decideAllFromApps(well, ['Brightloom'], 'exclude', 5, NOW)).toEqual({ ok: false, changed: 0, count: 4, refused: 'count-changed' })
    expect(decideAllFromApps(well, ['Brightloom'], 'exclude', 3, NOW)).toMatchObject({ ok: false, changed: 0 })
    expect(decisions()).toEqual(before)
  })

  it('only undecided rows change: his earlier decisions, an emptied marker and items in the Bin stay as they are', () => {
    expect(decideAllFromApps(well, ['Brightloom', 'Mossgrid'], 'select', 4, NOW).ok).toBe(true)
    expect(decisions()).toMatchObject({ b4: 'included', b5: 'excluded', m1: 'emptied' })
    expect(decisions().m2).toBeUndefined()
  })

  it('one transaction: a write that fails part-way leaves nothing behind', () => {
    const d = db()
    d.exec("CREATE TRIGGER fail_b3 BEFORE INSERT ON triage_decisions WHEN NEW.hash = 'b3' BEGIN SELECT RAISE(ABORT, 'no'); END")
    d.close()
    const before = decisions()
    expect(() => decideAllFromApps(well, ['Brightloom'], 'exclude', 4, NOW)).toThrow()
    expect(decisions()).toEqual(before)
  })

  it('bad arguments are refused: no apps, an action that is not select or exclude, a count that is not a whole number', () => {
    const before = decisions()
    expect(decideAllFromApps(well, [], 'exclude', 6, NOW)).toMatchObject({ ok: false, refused: 'bad-arguments' })
    expect(decideAllFromApps(well, ['Brightloom'], 'reset' as never, 4, NOW)).toMatchObject({ ok: false, refused: 'bad-arguments' })
    expect(decideAllFromApps(well, ['Brightloom'], 'exclude', 4.5, NOW)).toMatchObject({ ok: false, refused: 'bad-arguments' })
    expect(decideAllFromApps(well, ['Brightloom'], 'exclude', -1, NOW)).toMatchObject({ ok: false, refused: 'bad-arguments' })
    expect(decisions()).toEqual(before)
  })
})
