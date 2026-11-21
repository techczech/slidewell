// End-to-end: Review in the real app with three synthetic screenshot proposals.
// Keep, Throwaway, Undo and both piles, checking the scratch database and original bytes.
// Run: npm run test:review
import { finish, recordFailure } from './support/result.mjs'
import { createScratch, launchHidden } from './support/scratch.mjs'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'

const scratch = createScratch('review')
const userData = join(scratch, 'userData')
const well = join(scratch, 'well')
const source = join(well, 'source')
const screens = join(scratch, 'screens')
for (const dir of [userData, well, source, screens]) mkdirSync(dir)
writeFileSync(join(userData, 'config.json'), JSON.stringify({ wellRoot: well }))
const fixtureDb = new DatabaseSync(join(well, 'triage.db'))
try {
  fixtureDb.exec(`
    CREATE VIRTUAL TABLE triage_fts USING fts5(hash UNINDEXED, kind UNINDEXED, rel_path UNINDEXED, filename, ext UNINDEXED,
      size UNINDEXED, mtime UNINDEXED, poster_rel UNINDEXED, offline UNINDEXED, ocr_text, scanned_at UNINDEXED,
      source UNINDEXED, taken_at UNINDEXED, app, window_title);
    CREATE TABLE triage_decisions (hash TEXT PRIMARY KEY, state TEXT NOT NULL, decided_at TEXT, well_id TEXT);
    CREATE TABLE sorter_proposals (hash TEXT PRIMARY KEY, proposal TEXT NOT NULL, confidence REAL NOT NULL, p_keep REAL NOT NULL,
      reason TEXT NOT NULL, rule TEXT, sorter_version TEXT NOT NULL, model_id TEXT, proposed_at TEXT NOT NULL,
      throwaway_since TEXT, answered_at TEXT, answer TEXT, decided_by TEXT);
  `)
  const addShot = fixtureDb.prepare(`INSERT INTO triage_fts (hash, kind, rel_path, filename, ext, size, mtime, offline, source, taken_at)
    VALUES (?, 'image', ?, ?, 'png', ?, ?, '0', ?, ?)`)
  const propose = fixtureDb.prepare(`INSERT INTO sorter_proposals (hash, proposal, confidence, p_keep, reason, sorter_version, proposed_at)
    VALUES (?, 'doubtful', 0.6, 0.4, 'Synthetic proposal for Review', 'fixture', ?)`)
  for (const [index, colour] of ['#1e40af', '#9a3412', '#047857'].entries()) {
    const name = `sample-${index}.png`
    const path = join(source, name)
    const bytes = await sharp({ create: { width: 640, height: 400, channels: 3, background: colour } }).png().toBuffer()
    writeFileSync(path, bytes)
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12)
    const when = new Date(Date.now() - index * 60_000).toISOString()
    addShot.run(hash, name, name, String(bytes.length), String(Math.round(statSync(path).mtimeMs)), source, when)
    propose.run(hash, when)
  }
} finally {
  fixtureDb.close()
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) {
    recordFailure(name)
    failed++
  }
}
const db = (fn) => {
  const d = new DatabaseSync(join(well, 'triage.db'), { readOnly: true })
  try {
    return fn(d)
  } finally {
    d.close()
  }
}
const decision = (hash) => db((d) => d.prepare('SELECT state, decided_at, well_id FROM triage_decisions WHERE hash = ?').get(hash))
const answer = (hash) => db((d) => d.prepare('SELECT answer FROM sorter_proposals WHERE hash = ?').get(hash))?.answer ?? null
const original = (hash) => db((d) => d.prepare("SELECT source, rel_path FROM triage_fts WHERE hash = ? AND offline = '0' LIMIT 1").get(hash))
const fingerprint = (p) => {
  const st = statSync(p)
  return `${createHash('sha256').update(readFileSync(p)).digest('hex')}:${st.size}:${st.mtimeMs}:${st.ino}`
}
const decisionsBefore = db((d) => d.prepare('SELECT COUNT(*) AS n FROM triage_decisions').get().n)

const app = await launchHidden(userData, join(scratch, 'home'))
try {
  let win = null
  for (let i = 0; i < 300 && !win; i++) {
    win = app.windows().find((w) => !w.url().startsWith('swembed:') && w.url() !== 'about:blank') ?? null
    if (!win) await sleep(100)
  }
  if (!win) throw new Error('main window did not open')
  await win.waitForLoadState('domcontentloaded')
  await win.setViewportSize({ width: 1440, height: 900 })
  await win.locator('.view-switch .scope-tab', { hasText: 'Review' }).click()
  await win.waitForSelector('.rv-big', { timeout: 60000 })
  const h1 = () => win.locator('.rv-head h1').innerText()
  const ov = await win.evaluate(() => window.sw.review.overview({ queue: 5 }))
  console.log(`scratch: ${ov.needALook} need a look, ${ov.confident.kept} kept + ${ov.confident.throwaway} throwaway sorted confidently`)
  check('Review opens on the doubtful queue', (await h1()) === `${ov.needALook} need a look` && ov.needALook > 0)
  await sleep(500)
  await win.screenshot({ path: join(screens, 'review-1-doubtful.png') })

  const hash = await win.locator('.rv-big').getAttribute('data-hash')
  const orig = original(hash)
  const origPath = orig && join(orig.source, orig.rel_path)
  const before = origPath && existsSync(origPath) ? fingerprint(origPath) : null
  check('the card has an original on disk to protect', Boolean(before), origPath ?? 'none')

  await win.keyboard.press('k')
  await win.waitForFunction((n) => document.querySelector('.rv-head h1')?.textContent === `${n} need a look`, ov.needALook - 1, { timeout: 30000 })
  const kept = decision(hash)
  check('K: his decision is written (included, with a well id)', kept?.state === 'included' && Boolean(kept.well_id), JSON.stringify(kept))
  check('K: the proposal is marked answered', answer(hash) === 'keep')
  await win.keyboard.press('Meta+z')
  await win.waitForFunction((n) => document.querySelector('.rv-head h1')?.textContent === `${n} need a look`, ov.needALook, { timeout: 30000 })
  check('⌘Z: decision and answer restored', decision(hash) === undefined && answer(hash) === null)
  check('⌘Z: the card is back', (await win.locator('.rv-big').getAttribute('data-hash')) === hash)

  await win.keyboard.press('t')
  await win.waitForFunction((n) => document.querySelector('.rv-head h1')?.textContent === `${n} need a look`, ov.needALook - 1, { timeout: 30000 })
  check('T: his decision is excluded (a record; bin in 30 days)', decision(hash)?.state === 'excluded')
  const piles = await win.evaluate(() => window.sw.review.piles())
  check('T: it shows in Throwaway with bin in 30 days', piles.throwaway.items.some((c) => c.hash === hash && c.binInDays === 30))
  await win.keyboard.press('Meta+z')
  await win.waitForFunction((n) => document.querySelector('.rv-head h1')?.textContent === `${n} need a look`, ov.needALook, { timeout: 30000 })
  check('⌘Z after T: restored', decision(hash) === undefined)

  await win.locator('.rv-pile-btn').click()
  await win.waitForSelector('.rv-pl-left')
  await sleep(800)
  check('Show both piles', (await h1()) === 'Both piles')
  await win.screenshot({ path: join(screens, 'review-2-both-piles.png') })
  await win.keyboard.press('Escape')
  check('Esc back to doubtful', (await h1()).endsWith('need a look'))

  check('the original behind the card is byte-identical, same inode and mtime', before !== null && fingerprint(origPath) === before)
  check('no decision left behind in the scratch copy', db((d) => d.prepare('SELECT COUNT(*) AS n FROM triage_decisions').get().n) === decisionsBefore)
} finally {
  await app.close()
}
console.log(failed ? `${failed} FAILED` : 'all passed')
finish(failed ? 'assertion failed' : null)
