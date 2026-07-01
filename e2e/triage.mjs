// Isolated triage e2e (ADR-0029). Runs the real scan → list → select → importSelected flow through
// the app's IPC, against throwaway dirs (temp userData + temp well + a fixture source folder), so it
// never touches the user's real well/config. Run: `node e2e/triage.mjs` (after `npm run build`).
import { _electron as electron } from 'playwright'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const out = (o) => console.log(JSON.stringify(o))

// two distinct 1x1 PNGs (different bytes → different content hashes)
const RED = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const BLUE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const work = mkdtempSync(join(tmpdir(), 'sw-triage-'))
const userData = join(work, 'userData')
const wellRoot = join(work, 'well')
const source = join(work, 'source')
mkdirSync(userData, { recursive: true })
mkdirSync(join(source, 'sub'), { recursive: true }) // a subfolder, to prove recursive traversal
writeFileSync(join(source, 'one.png'), Buffer.from(RED, 'base64'))
writeFileSync(join(source, 'sub', 'two.png'), Buffer.from(BLUE, 'base64')) // nested
writeFileSync(join(source, 'dup.png'), Buffer.from(BLUE, 'base64')) // SAME bytes as two.png → same content hash
// distinct capture dates so date sort/group has something to order
utimesSync(join(source, 'one.png'), new Date('2024-06-01'), new Date('2024-06-01'))
utimesSync(join(source, 'sub', 'two.png'), new Date('2020-01-15'), new Date('2020-01-15'))
utimesSync(join(source, 'dup.png'), new Date('2022-03-03'), new Date('2022-03-03'))
// pre-seed the config the app reads (isolated well + the fixture as the Triage source)
writeFileSync(join(userData, 'config.json'), JSON.stringify({ wellRoot, screenshotRoot: source }), 'utf8')

const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`] })
let pass = false
const result = {}
try {
  const win = await app.firstWindow({ timeout: 20000 })
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(500)

  // open Triage from the toolbar
  await win.locator('.titlebar-actions .tb-btn', { hasText: 'Triage' }).click()
  await win.waitForSelector('.triage-panel', { timeout: 5000 })
  result.panelOpened = (await win.locator('.triage-panel').count()) === 1

  // scan the fixture (recursive: 3 files across a subfolder, two of them byte-identical)
  const scan = await win.evaluate(() => window.sw.triage.scan())
  result.scanned = scan.indexed
  result.recursiveOk = scan.total === 3 // found the nested file too

  const all0 = (await win.evaluate(() => window.sw.triage.list('', 'all', 'date-desc', 50, 0))).items
  result.undecidedAfterScan = (await win.evaluate(() => window.sw.triage.list('', 'undecided'))).counts.undecided
  // unique React keys: 3 distinct files but only 2 distinct content hashes (two.png == dup.png)
  result.distinctPaths = new Set(all0.map((i) => i.relPath)).size
  result.distinctHashes = new Set(all0.map((i) => i.hash)).size

  // render check: force the UI to re-list (switch to All), then confirm ALL THREE cards render
  // (regression: cards keyed by content hash collided for duplicates → ghost cards) AND have real
  // height (earlier regression: aspect-ratio thumb collapsed the flex card to ~2px)
  await win.locator('.triage-controls .scope-tab', { hasText: 'All' }).click()
  await win.waitForTimeout(600)
  result.cardsRendered = await win.locator('.triage-card').count()
  result.cardHeightOk = await win.evaluate(() => {
    const c = document.querySelector('.triage-card')
    return c ? c.getBoundingClientRect().height > 100 : false
  })

  // group-by-date must stay a 6-column grid (regression: it collapsed to a 1-col list because
  // `1fr` tracks couldn't shrink below the filename width)
  await win.locator('.triage-controls .toggle input').check()
  await win.waitForTimeout(500)
  result.groupCols = await win.evaluate(() => {
    const g = document.querySelector('.triage-group .triage-grid')
    return g ? getComputedStyle(g).gridTemplateColumns.split(/\s+/).filter(Boolean).length : 0
  })
  await win.locator('.triage-controls .toggle input').uncheck()
  await win.waitForTimeout(300)

  // stage two items via select — NOTHING should reach the well yet (stage-then-import flow)
  // all0 is sorted date-desc: all0[0]=one.png (2024), all0[1]=dup.png (2022), all0[2]=two.png (2020)
  await win.evaluate((h) => window.sw.triage.decide(h, 'select'), all0[0].hash)
  await win.evaluate((h) => window.sw.triage.decide(h, 'select'), all0[1].hash)
  result.selectedCount = (await win.evaluate(() => window.sw.triage.list('', 'selected'))).counts.selected
  const { readdirSync, existsSync } = await import('node:fs')
  // 'images' subdir confirmed from well.ts (ingestScreenshot writes <well>/images/<slug>--<id>.<ext>)
  const wellImages = join(wellRoot, 'images')
  result.wellEmptyBeforeImport = !existsSync(wellImages) || readdirSync(wellImages).length === 0

  // exclude one of the DUPLICATES → both byte-identical files share the hash-keyed decision
  // (this overrides the 'selected' state for that hash, leaving only one.png staged)
  const twoItem = all0.find((i) => i.filename === 'two.png')
  await win.evaluate((h) => window.sw.triage.decide(h, 'exclude'), twoItem.hash)
  const after = await win.evaluate(() => window.sw.triage.list('', 'all'))
  result.excludedCount = after.counts.excluded // two.png + dup.png (shared content hash)
  result.undecidedCount = after.counts.undecided
  result.includedBeforeImport = after.counts.included

  // import all staged items → one.png is promoted to the well; dup.png/two.png hash is excluded so skipped
  const imp = await win.evaluate(() => window.sw.triage.importSelected([]))
  result.imported = imp.imported
  result.wellHasImagesAfterImport = existsSync(wellImages) && readdirSync(wellImages).length >= 1
  result.includedAfterImport = (await win.evaluate(() => window.sw.triage.list('', 'all'))).counts.included

  // date sort: newest-first vs oldest-first must flip, and every item carries a YYYY-MM-DD date
  const desc = await win.evaluate(() => window.sw.triage.list('', 'all', 'date-desc'))
  const asc = await win.evaluate(() => window.sw.triage.list('', 'all', 'date-asc'))
  result.datesOk = desc.items.every((i) => /^\d{4}-\d{2}-\d{2}$/.test(i.date))
  result.dateSortFlips = desc.items[0].relPath === asc.items[asc.items.length - 1].relPath && desc.items[0].date >= desc.items[1].date

  pass =
    result.panelOpened &&
    result.scanned === 3 &&
    result.recursiveOk &&
    result.undecidedAfterScan === 3 &&
    result.distinctPaths === 3 &&
    result.distinctHashes === 2 &&
    result.cardsRendered === 3 &&
    result.cardHeightOk &&
    result.groupCols === 6 &&
    result.selectedCount === 3 &&
    result.includedBeforeImport === 0 &&
    result.wellEmptyBeforeImport &&
    result.excludedCount === 2 &&
    result.undecidedCount === 0 &&
    result.imported >= 1 &&
    result.wellHasImagesAfterImport &&
    result.includedAfterImport >= 1 &&
    result.datesOk &&
    result.dateSortFlips
} catch (e) {
  result.error = String(e)
} finally {
  await app.close()
  rmSync(work, { recursive: true, force: true })
}
out({ ...result, pass })
process.exit(pass ? 0 : 1)
