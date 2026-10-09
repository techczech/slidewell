// Backlog import e2e (ticket 13): Settings → "Show what would move" (dry run, nothing changes) →
// "Bring them in" → copies verified, Desktop originals moved, CleanShot history untouched.
// Everything runs under a scratch HOME in ~/Library/Caches/slidewell-dev-13/ (Desktop and CleanShot
// history are fixtures there), with a scratch userData. Never clicks "Point CleanShot here".
// Run: `npx electron-vite build && node e2e/backlog-import.mjs [screenshot.png]`.
import { _electron as electron } from 'playwright'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'

const out = (o) => console.log(JSON.stringify(o))
const PNG = (seed) => Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), Buffer.from(seed)])

const work = join(homedir(), 'Library', 'Caches', 'slidewell-dev-13', `e2e-${process.pid}`)
rmSync(work, { recursive: true, force: true })
const home = join(work, 'home')
const desktop = join(home, 'Desktop')
const media = join(home, 'Library', 'Application Support', 'CleanShot', 'media')
const watched = join(work, 'Watched')
const userData = join(work, 'userData')
for (const d of [desktop, media, watched, userData, join(work, 'well')]) mkdirSync(d, { recursive: true })
writeFileSync(join(desktop, 'Screenshot 2026-10-08 at 10.05.01.png'), PNG('d1'))
writeFileSync(join(desktop, 'CleanShot 2026-10-08 at 0801 from Safari.png'), PNG('d2'))
writeFileSync(join(desktop, 'Notes.txt'), 'not a screenshot')
for (const [dir, name, seed] of [['media_a', 'CleanShot 2026-10-01 at 0900.png', 'c1'], ['media_b', 'CleanShot 2026-10-01 at 0901.png', 'c2'], ['media_c', 'CleanShot 2026-10-01 at 0902.cleanshot', 'p']]) {
  mkdirSync(join(media, dir), { recursive: true })
  writeFileSync(join(media, dir, name), PNG(seed))
}
writeFileSync(join(userData, 'config.json'), JSON.stringify({ wellRoot: join(work, 'well'), screenshotRoot: watched }), 'utf8')

const snap = (dir) => {
  const o = {}
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else o[relative(work, p)] = createHash('sha256').update(readFileSync(p)).digest('hex') + ':' + statSync(p).mtimeMs
    }
  }
  walk(dir)
  return o
}
const watchedFiles = () => readdirSync(watched, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name).sort()

const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env: { ...process.env, HOME: home, SLIDEWELL_E2E_HIDDEN: '1' } })
const r = {}
let pass = false
try {
  const win = await app.firstWindow({ timeout: 20000 })
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(800)
  r.runWithoutPlanRefused = Boolean((await win.evaluate(() => window.sw.backlog.run('not-a-plan')))?.refused)

  await win.locator('.tb-btn[title^="Settings"]').click()
  await win.waitForSelector('.settings-modal')
  const before = snap(work)
  await win.locator('button', { hasText: 'Show what would move' }).click()
  await win.waitForSelector('[data-testid="backlog-plan"]', { timeout: 10000 })
  const planText = await win.locator('[data-testid="backlog-plan"]').innerText()
  r.planShowsCounts = planText.includes('4 files to bring in') && planText.includes('Desktop screenshots') && planText.includes('CleanShot history')
  r.planShowsExamples = planText.includes('Screenshot 2026-10-08 at 10.05.01.png')
  r.dryRunChangedNothing = JSON.stringify(snap(work)) === JSON.stringify(before) && !existsSync(join(userData, 'backlog-import'))
  await win.locator('[data-testid="backlog-plan"]').scrollIntoViewIfNeeded()
  if (process.argv[2]) await win.locator('.settings-modal').screenshot({ path: process.argv[2].replace(/\.png$/, '-plan.png') })

  const csBefore = snap(media)
  await win.locator('button', { hasText: 'Bring them in' }).click()
  await win.waitForSelector('[data-testid="backlog-result"]', { timeout: 20000 })
  r.resultText = (await win.locator('[data-testid="backlog-result"]').innerText()).replace(/\s+/g, ' ')
  r.watched = watchedFiles()
  r.moved = readdirSync(join(watched, readdirSync(watched).find((n) => n.startsWith('Moved by SlideWell')) ?? 'missing')).sort()
  r.desktopLeft = readdirSync(desktop)
  r.cleanshotUntouched = JSON.stringify(snap(media)) === JSON.stringify(csBefore)
  r.cleanshotOffer = (await win.locator('[data-testid="backlog-cleanshot"]').count()) === 1
  if (process.argv[2]) await win.locator('.settings-modal').screenshot({ path: process.argv[2] })

  // second dry run: nothing left
  await win.locator('button', { hasText: 'Show what would move' }).click()
  await win.waitForSelector('[data-testid="backlog-plan"]')
  r.secondPlanEmpty = (await win.locator('[data-testid="backlog-plan"]').innerText()).includes('Nothing left to bring in')

  pass =
    r.runWithoutPlanRefused &&
    r.planShowsCounts &&
    r.planShowsExamples &&
    r.dryRunChangedNothing &&
    r.watched.length === 4 &&
    r.moved.length === 2 &&
    JSON.stringify(r.desktopLeft) === JSON.stringify(['Notes.txt']) &&
    r.cleanshotUntouched &&
    r.cleanshotOffer &&
    r.secondPlanEmpty
} catch (e) {
  r.error = String(e)
} finally {
  await app.close()
  if (pass) rmSync(work, { recursive: true, force: true })
}
out({ pass, ...r })
process.exit(pass ? 0 : 1)
