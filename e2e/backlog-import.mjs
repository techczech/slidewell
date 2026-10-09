// Backlog import e2e (ticket 13, copy only): Settings → "Show what would be copied" (dry run, nothing
// changes) → "Bring them in" → copies verified; every original (Desktop and CleanShot history) untouched.
// Everything runs under a scratch HOME in ~/Library/Caches/slidewell-dev-13/ (Desktop and CleanShot
// history are fixtures there), with a scratch userData. Never clicks "Point CleanShot here".
// Run: `npx electron-vite build && node e2e/backlog-import.mjs [screenshot.png]`.
import { _electron as electron } from 'playwright'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
for (const d of [desktop, media, watched, userData, join(work, 'well'), join(work, 'elsewhere')]) mkdirSync(d, { recursive: true })
writeFileSync(join(desktop, 'Screenshot 2026-10-08 at 10.05.01.png'), PNG('d1'))
writeFileSync(join(desktop, 'CleanShot 2026-10-08 at 0801 from Safari.png'), PNG('d2'))
writeFileSync(join(desktop, 'Notes.txt'), 'not a screenshot')
for (const [dir, name, seed] of [['media_a', 'CleanShot 2026-10-01 at 0900.png', 'c1'], ['media_b', 'CleanShot 2026-10-01 at 0901.png', 'c2'], ['media_c', 'CleanShot 2026-10-01 at 0902.cleanshot', 'p']]) {
  mkdirSync(join(media, dir), { recursive: true })
  writeFileSync(join(media, dir, name), PNG(seed))
}
// An earlier run copied this one, but its copy has since disappeared: Settings must offer to copy it again.
const PENDING = 'Screenshot 2026-10-07 at 09.00.00.png'
writeFileSync(join(desktop, PENDING), PNG('pending'))
{
  const from = join(realpathSync.native(desktop), PENDING)
  const st = statSync(from)
  mkdirSync(join(userData, 'backlog-import'), { recursive: true })
  const entry = { step: 'copied', hash: createHash('sha256').update(PNG('pending')).digest('hex'), watched: realpathSync.native(watched), source: 'desktop', from, size: st.size, mtimeMs: Math.round(st.mtimeMs), dest: join(realpathSync.native(watched), PENDING), at: new Date().toISOString() }
  writeFileSync(join(userData, 'backlog-import', 'backlog-ledger.jsonl'), JSON.stringify(entry) + '\n')
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
  await win.locator('button', { hasText: 'Show what would be copied' }).click()
  await win.waitForSelector('[data-testid="backlog-plan"]', { timeout: 10000 })
  const planText = await win.locator('[data-testid="backlog-plan"]').innerText()
  r.planShowsCounts = planText.includes('5 files to copy') && planText.includes('Desktop screenshots') && planText.includes('CleanShot history')
  r.planShowsExamples = planText.includes('Screenshot 2026-10-08 at 10.05.01.png')
  r.planShowsRecopy = planText.includes('1 file copied before, but the copy is missing or changed')
  r.dryRunChangedNothing = JSON.stringify(snap(work)) === JSON.stringify(before)
  await win.locator('[data-testid="backlog-plan"]').scrollIntoViewIfNeeded()
  if (process.argv[2]) await win.locator('.settings-modal').screenshot({ path: process.argv[2].replace(/\.png$/, '-plan.png') })

  const csBefore = snap(media)
  const desktopBefore = snap(desktop)
  await win.locator('button', { hasText: 'Bring them in' }).click()
  await win.waitForSelector('[data-testid="backlog-result"]', { timeout: 20000 })
  r.resultText = (await win.locator('[data-testid="backlog-result"]').innerText()).replace(/\s+/g, ' ')
  r.watched = watchedFiles()
  r.noMovedFolder = !readdirSync(watched).some((n) => n.startsWith('Moved by SlideWell'))
  r.stagingEmpty = readdirSync(join(watched, '.slidewell-staging')).length === 0
  r.desktopUntouched = JSON.stringify(snap(desktop)) === JSON.stringify(desktopBefore)
  r.desktopNote = (await win.locator('[data-testid="backlog-desktop-note"]').innerText().catch(() => '')).includes('3 originals are still on your Desktop')
  r.cleanshotUntouched = JSON.stringify(snap(media)) === JSON.stringify(csBefore)
  r.cleanshotOffer = (await win.locator('[data-testid="backlog-cleanshot"]').count()) === 1
  if (process.argv[2]) await win.locator('.settings-modal').screenshot({ path: process.argv[2] })

  // Triage indexes the five copies and nothing from the hidden staging folder (the post-run scan is explicit, not watcher-driven)
  let tri = []
  for (let i = 0; i < 30 && tri.length < 5; i++) {
    await win.waitForTimeout(1000)
    tri = (await win.evaluate(() => window.sw.triage.list('', 'all', 'scanned', 50, 0))).items
  }
  r.triageItems = tri.length
  r.triageSkipsStaging = tri.length === 5 && tri.every((x) => !x.relPath.includes('.slidewell-staging'))
  // The CleanShot write refuses a folder other than the watched one (no real write happens here)
  r.cleanshotRefusesOtherFolder = Boolean((await win.evaluate((p) => window.sw.backlog.setCleanShot(p), join(work, 'elsewhere')))?.refused)

  // second dry run: nothing left
  await win.locator('button', { hasText: 'Show what would be copied' }).click()
  await win.waitForSelector('[data-testid="backlog-plan"]')
  r.secondPlanEmpty = (await win.locator('[data-testid="backlog-plan"]').innerText()).includes('Nothing left to bring in')

  pass =
    r.runWithoutPlanRefused &&
    r.planShowsCounts &&
    r.planShowsExamples &&
    r.dryRunChangedNothing &&
    r.planShowsRecopy &&
    r.watched.length === 5 &&
    r.noMovedFolder &&
    r.stagingEmpty &&
    r.desktopUntouched &&
    r.desktopNote &&
    r.cleanshotUntouched &&
    r.cleanshotOffer &&
    r.triageSkipsStaging &&
    r.cleanshotRefusesOtherFolder &&
    r.secondPlanEmpty
} catch (e) {
  r.error = String(e)
} finally {
  await app.close()
  if (pass) rmSync(work, { recursive: true, force: true })
}
out({ pass, ...r })
process.exit(pass ? 0 : 1)
