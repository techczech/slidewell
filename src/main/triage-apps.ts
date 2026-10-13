/**
 * Triage by source app (ticket 20): the per-app tallies behind the App menu and the "What the sorter
 * goes by" table, and the bulk decision "exclude all / select all undecided from these apps".
 *
 * The app name is the one parsed from a CleanShot file name at scan time (triage_fts.app; '' when the
 * name carries none: "App not known"). Names compare as appKey does (trimmed, without case) and are
 * shown in their most common spelling. triage_fts stays rebuildable: nothing here is stored in it.
 *
 * File-row counts (the App menu, "still undecided", bulk decide) follow the Triage list (triage.ts
 * listTriage): an emptied item is gone and an item in the review Bin is not listed (review/store.ts,
 * the same clock); rows are counted per file, as the list and the tab counts do. His decisions (kept,
 * thrown away, the kept share and so the suggestions) are history, counted per picture (content hash,
 * the decision key) whatever the lists show: a picture he threw away still counts once it is in the Bin.
 *
 * decideAllFromApps is the one write: his own decision for many screenshots at once, in
 * triage_decisions. No file is read, moved, deleted or renamed.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { TriageAppCount, TriageBulkResult } from '../preload'
import { hiddenIn } from './review/store'
import { appKey } from './triage-logic'

export const MAX_APPS = 200
export const MAX_APP_NAME = 200

type ListState = 'undecided' | 'selected' | 'included' | 'excluded'

export type AppTally = {
  /** appKey of the name; '' = app not known. */
  key: string
  /** The most common spelling in the index ('' = app not known). */
  app: string
  /** His decisions for pictures from this app, in the Bin or not: selected or included = kept, excluded = thrown away. */
  kept: number
  thrownAway: number
  /** File rows per state, as the Triage lists show them. */
  rows: Record<ListState, number>
}

/** An app list from the renderer: an array of at most MAX_APPS names, each a string of at most MAX_APP_NAME characters; else null. */
export function cleanAppList(x: unknown): string[] | null {
  if (!Array.isArray(x) || x.length > MAX_APPS) return null
  for (const a of x) if (typeof a !== 'string' || a.length > MAX_APP_NAME) return null
  return x as string[]
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name))
}

type Row = { hash: string; app: string | null; state: string | null }

/** Every file row with his decision for its picture, whatever the lists show. */
function allRows(db: DatabaseSync): Row[] {
  if (!hasTable(db, 'triage_fts')) return []
  const decisions = hasTable(db, 'triage_decisions')
  return db
    .prepare(`SELECT f.hash AS hash, f.app AS app, ${decisions ? 'd.state' : 'NULL'} AS state FROM triage_fts f ${decisions ? 'LEFT JOIN triage_decisions d ON d.hash = f.hash' : ''}`)
    .all() as Row[]
}

/** The file rows the Triage lists show: emptied items and the review Bin left out. */
function visibleRows(db: DatabaseSync, now: number): Row[] {
  const hidden = hiddenIn(db, now)
  return allRows(db).filter((r) => r.state !== 'emptied' && !hidden.has(r.hash))
}

/** One tally per app name in the index (any state), in no particular order. */
export function readAppTallies(wellRoot: string, now = Date.now()): AppTally[] {
  const file = join(wellRoot, 'triage.db')
  if (!existsSync(file)) return []
  const db = new DatabaseSync(file, { readOnly: true })
  db.exec('PRAGMA busy_timeout=5000;')
  try {
    if (!hasTable(db, 'triage_fts')) return []
    // spellings: of the rows the lists show; hiddenSpellings: of the rest, used only when no row of the app is shown
    type Acc = { tally: AppTally; spellings: Map<string, number>; hiddenSpellings: Map<string, number>; kept: Set<string>; thrown: Set<string> }
    const by = new Map<string, Acc>()
    /** The app's tally, without counting a spelling. */
    const acc0 = (app: string | null): Acc => {
      const key = appKey(app)
      let a = by.get(key)
      if (!a) by.set(key, (a = { tally: { key, app: '', kept: 0, thrownAway: 0, rows: { undecided: 0, selected: 0, included: 0, excluded: 0 } }, spellings: new Map(), hiddenSpellings: new Map(), kept: new Set(), thrown: new Set() }))
      return a
    }
    const acc = (app: string | null, shown = true): Acc => {
      const a = acc0(app)
      const spelt = (app ?? '').trim()
      const into = shown ? a.spellings : a.hiddenSpellings
      into.set(spelt, (into.get(spelt) ?? 0) + 1)
      return a
    }
    // every app in the index gets a tally, also one whose rows are all hidden
    for (const r of db.prepare('SELECT DISTINCT app FROM triage_fts').all() as Array<{ app: string | null }>) acc0(r.app)
    const hidden = hiddenIn(db, now)
    for (const r of allRows(db)) {
      // his decisions are history: every one counts, also for a picture now in the Bin. An emptied
      // marker is not a keep or a throw-away and counts as neither.
      if (r.state === 'selected' || r.state === 'included') acc0(r.app).kept.add(r.hash)
      else if (r.state === 'excluded') acc0(r.app).thrown.add(r.hash)
      // file rows and spellings as the lists show them
      if (r.state === 'emptied' || hidden.has(r.hash)) {
        acc(r.app, false)
        continue
      }
      const a = acc(r.app)
      const state: ListState = r.state === 'selected' || r.state === 'included' || r.state === 'excluded' ? r.state : 'undecided'
      a.tally.rows[state]++
    }
    return [...by.values()].map((a) => {
      // the most common spelling; of equally common ones, the first in plain order
      const spelt = [...(a.spellings.size ? a.spellings : a.hiddenSpellings)].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))[0]?.[0]
      return { ...a.tally, app: spelt ?? a.tally.key, kept: a.kept.size, thrownAway: a.thrown.size }
    })
  } finally {
    db.close()
  }
}

/** Known apps by name, "app not known" last. */
export function byAppName<T extends { app: string }>(a: T, b: T): number {
  if ((a.app === '') !== (b.app === '')) return a.app === '' ? 1 : -1
  const x = appKey(a.app)
  const y = appKey(b.app)
  return x < y ? -1 : x > y ? 1 : 0
}

/**
 * The App menu: each app with rows in this state tab ('all' = every state), its count there, and his
 * kept share for the app from all his decisions (null when he has decided none). Most rows first,
 * "app not known" last.
 */
export function appCounts(wellRoot: string, state: string, now = Date.now()): TriageAppCount[] {
  const count = (t: AppTally): number => (state === 'all' ? t.rows.undecided + t.rows.selected + t.rows.included + t.rows.excluded : (t.rows[state as ListState] ?? 0))
  return readAppTallies(wellRoot, now)
    .map((t) => ({ app: t.app, count: count(t), kept: t.kept, thrownAway: t.thrownAway, keptShare: t.kept + t.thrownAway ? t.kept / (t.kept + t.thrownAway) : null }))
    .filter((a) => a.count > 0)
    .sort((a, b) => (a.app === '' ? 1 : 0) - (b.app === '' ? 1 : 0) || b.count - a.count || byAppName(a, b))
}

/**
 * Exclude all or select all undecided screenshots from these apps ('' = app not known): his decision,
 * written like one from the Triage panel (select = staged, exclude = remembered by hash).
 *
 * `expected` is the count he was shown and confirmed. In one write transaction the undecided rows from
 * these apps are counted again, as the list shows them; if the count differs, nothing is written
 * (refused 'count-changed'). Otherwise each of those pictures gets the decision, and only where it has
 * none: an earlier decision of his, an emptied marker and anything in the review Bin are never
 * touched.
 *
 * A decision is kept per picture (content hash), not per file. A picture that also sits as an
 * undecided row under an app he did not tick is therefore skipped: deciding it would decide that row
 * too, outside what he confirmed. `changed` is the number of rows from these apps that are no longer
 * undecided, `skipped` the number left undecided for that reason; changed + skipped = count.
 */
export function decideAllFromApps(wellRoot: string, apps: string[], action: 'select' | 'exclude', expected: number, now = Date.now()): TriageBulkResult {
  const bad: TriageBulkResult = { ok: false, changed: 0, skipped: 0, count: 0, refused: 'bad-arguments' }
  const list = cleanAppList(apps)
  if (!list || !list.length || (action !== 'select' && action !== 'exclude') || !Number.isSafeInteger(expected) || expected < 0) return bad
  const file = join(wellRoot, 'triage.db')
  if (!existsSync(file)) return expected === 0 ? { ok: true, changed: 0, skipped: 0, count: 0 } : { ok: false, changed: 0, skipped: 0, count: 0, refused: 'count-changed' }
  const wanted = new Set(list.map(appKey))
  const state = action === 'exclude' ? 'excluded' : 'selected'
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA busy_timeout=5000;')
    db.exec('CREATE TABLE IF NOT EXISTS triage_decisions (hash TEXT PRIMARY KEY, state TEXT NOT NULL, decided_at TEXT, well_id TEXT)')
    const put = db.prepare('INSERT INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, ?, ?, NULL) ON CONFLICT(hash) DO NOTHING')
    const at = new Date(now).toISOString()
    db.exec('BEGIN IMMEDIATE')
    try {
      const undecided = visibleRows(db, now).filter((r) => !r.state)
      const rows = undecided.filter((r) => wanted.has(appKey(r.app)))
      if (rows.length !== expected) {
        db.exec('ROLLBACK')
        return { ok: false, changed: 0, skipped: 0, count: rows.length, refused: 'count-changed' }
      }
      // pictures that are also undecided under an app outside the ticked ones stay undecided
      const elsewhere = new Set(undecided.filter((r) => !wanted.has(appKey(r.app))).map((r) => r.hash))
      const mine = rows.filter((r) => !elsewhere.has(r.hash))
      for (const hash of new Set(mine.map((r) => r.hash))) put.run(hash, state, at)
      db.exec('COMMIT')
      return { ok: true, changed: mine.length, skipped: rows.length - mine.length, count: rows.length }
    } catch (e) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* the failed statement already ended the transaction */
      }
      throw e
    }
  } finally {
    db.close()
  }
}
