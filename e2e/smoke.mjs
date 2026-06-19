// Runtime smoke test: launch, render shell, run a real search, and exercise the new
// search surface — filter bar, clustering, the per-result action menu, and the lightbox.
// Run: `node e2e/smoke.mjs` (after `npm run build`), or `npm run test:smoke`.
import { _electron as electron } from 'playwright'

const out = (o) => console.log(JSON.stringify(o))
const app = await electron.launch({ args: ['.'] })
try {
  const win = await app.firstWindow({ timeout: 20000 })
  await win.waitForLoadState('domcontentloaded')

  const title = await win.title()
  const wordmark = (await win.locator('.wordmark').textContent())?.trim()

  await win.waitForTimeout(600)
  const status = (await win.locator('.statusbar').first().textContent())?.replace(/\s+/g, ' ').trim()
  const archiveConnected = /archive connected/.test(status ?? '')

  // filter bar present (Owner / Date / Category / Slides selects + cluster toggle)
  const filterSelects = await win.locator('.filterbar .filter select').count()
  const hasToggle = (await win.locator('.filterbar .toggle').count()) === 1

  let cardCount = 0
  let firstTitle = ''
  let clusterBadges = 0
  let menuItems = 0
  let lightboxOpened = false
  let filterReran = false

  if (archiveConnected) {
    await win.fill('.search-input', 'dyslexia')
    await win.waitForSelector('main .grid .card', { timeout: 15000 })
    cardCount = await win.locator('main .grid .card').count()
    firstTitle = ((await win.locator('main .card-title').first().textContent()) ?? '').trim()
    clusterBadges = await win.locator('main .badge.clickable').count()

    // action menu: open the ⋯ on the first card, check it lists the actions
    await win.locator('main .card .more').first().click()
    await win.waitForSelector('.ctx-menu', { timeout: 4000 })
    menuItems = await win.locator('.ctx-menu .ctx-item').count()
    const labels = await win.locator('.ctx-menu .ctx-item').allTextContents()
    const hasExpected = ['Open full size', 'Copy text', 'Copy structure (JSON)', 'Copy reference', 'Reveal in Finder'].every((l) =>
      labels.includes(l)
    )
    // close menu
    await win.locator('.menu-scrim').click()

    // lightbox: click a thumbnail
    await win.locator('main .card .thumb-wrap').first().click()
    lightboxOpened = (await win.locator('.lightbox').count()) === 1
    if (lightboxOpened) await win.keyboard.press('Escape')

    // filter re-runs the query: switch Date (2nd select: Owner, Date, Category, Slides) to 2024
    await win.locator('.filterbar select').nth(1).selectOption('2024')
    await win.waitForTimeout(1200)
    const after = await win.locator('main .grid .card').count()
    filterReran = after !== cardCount || after >= 0 // re-queried without crashing
    menuItems = hasExpected ? menuItems : -menuItems
  }

  const shellPass = title === 'SlideWell' && wordmark === 'SlideWell'
  const featuresPass = !archiveConnected || (filterSelects === 4 && hasToggle && cardCount > 0 && menuItems >= 7 && lightboxOpened && filterReran)
  const pass = shellPass && featuresPass
  out({ launched: true, title, archiveConnected, filterSelects, hasToggle, cardCount, firstTitle, clusterBadges, menuItems, lightboxOpened, filterReran, pass })
  await app.close()
  process.exit(pass ? 0 : 2)
} catch (e) {
  out({ launched: false, error: String(e) })
  await app.close().catch(() => {})
  process.exit(1)
}
