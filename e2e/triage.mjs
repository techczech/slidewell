// Isolated triage e2e (ADR-0029). Runs the real scan → list → include flow through the app's IPC,
// but against throwaway dirs (temp userData + temp well + a fixture source folder), so it never
// touches the user's real well/config. Run: `node e2e/triage.mjs` (after `npm run build`).
import { _electron as electron } from 'playwright'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
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

  // scan the fixture (recursive: 2 files across a subfolder)
  const scan = await win.evaluate(() => window.sw.triage.scan())
  result.scanned = scan.indexed
  result.recursiveOk = scan.total === 2 // found the nested file too

  // list undecided
  let listing = await win.evaluate(() => window.sw.triage.list('', 'undecided'))
  result.undecidedAfterScan = listing.counts.undecided

  // include the first item → it should leave 'undecided' and appear in 'included'
  const firstHash = listing.items[0].hash
  const dec = await win.evaluate((h) => window.sw.triage.decide(h, 'include'), firstHash)
  result.includeState = dec.state
  result.wellId = Boolean(dec.wellId)

  listing = await win.evaluate(() => window.sw.triage.list('', 'all'))
  result.includedCount = listing.counts.included
  result.undecidedCount = listing.counts.undecided

  // exclude the other → remembered by hash
  const other = listing.items.find((i) => i.state === 'undecided')
  await win.evaluate((h) => window.sw.triage.decide(h, 'exclude'), other.hash)
  const after = await win.evaluate(() => window.sw.triage.list('', 'all'))
  result.excludedCount = after.counts.excluded

  // the grid should have rendered cards for the scanned items
  await win.waitForTimeout(300)
  result.cardsRendered = await win.locator('.triage-card').count()

  pass =
    result.panelOpened &&
    result.scanned === 2 &&
    result.recursiveOk &&
    result.undecidedAfterScan === 2 &&
    result.includeState === 'included' &&
    result.wellId &&
    result.includedCount === 1 &&
    result.undecidedCount === 1 &&
    result.excludedCount === 1
} catch (e) {
  result.error = String(e)
} finally {
  await app.close()
  rmSync(work, { recursive: true, force: true })
}
out({ ...result, pass })
process.exit(pass ? 0 : 1)
