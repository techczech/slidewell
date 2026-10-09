// End-to-end: the Review tab in the real app, hidden, against a scratch profile + scratch well (a copy
// of a triage.db that holds sorter proposals). Keep / undo / Throwaway / undo / both piles, checking the
// scratch database after each step and that the original file behind the card is untouched.
//
// Run after `npm run build`:
//   SLIDEWELL_REVIEW_SCRATCH=<folder holding userData/config.json (wellRoot inside it), well/, home/> node e2e/review.mjs
// Screenshots go to <scratch>/screens. Every launch is SLIDEWELL_E2E_HIDDEN=1 with its own user-data-dir;
// never touches the installed app. Originals are only read (stat + hash).
import { _electron as electron } from 'playwright'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const scratch = process.env.SLIDEWELL_REVIEW_SCRATCH && resolve(process.env.SLIDEWELL_REVIEW_SCRATCH)
const cfgPath = scratch && join(scratch, 'userData', 'config.json')
if (!scratch || !existsSync(cfgPath)) {
  console.error('Set SLIDEWELL_REVIEW_SCRATCH to a folder with userData/config.json, well/ and home/.')
  process.exit(2)
}
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
if (!cfg.wellRoot || !resolve(cfg.wellRoot).startsWith(scratch + '/')) {
  console.error('Refusing: the scratch config must point wellRoot inside the scratch folder.')
  process.exit(2)
}
if (cfg.screenshotRoot || (cfg.captureSources ?? []).length) {
  console.error('Refusing: the scratch config must name no source folders (the app would scan them).')
  process.exit(2)
}
const well = cfg.wellRoot
const screens = join(scratch, 'screens')
mkdirSync(screens, { recursive: true })
mkdirSync(join(scratch, 'home'), { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) failed++
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

const app = await electron.launch({ args: ['.', `--user-data-dir=${join(scratch, 'userData')}`], env: { ...process.env, HOME: join(scratch, 'home'), SLIDEWELL_E2E_HIDDEN: '1' } })
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
process.exit(failed ? 1 : 0)
