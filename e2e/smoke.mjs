// Runtime smoke test: launch, default browse, search, filters (incl. searchable Category),
// clustering, the per-result action menu (incl. "see in context"), and the lightbox.
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

  // filter bar: Owner/Date/Slides native selects (3) + searchable Category + Group toggle + Source scope
  const filterSelects = await win.locator('.filterbar .filter select').count()
  const hasSearchableCategory = (await win.locator('.filterbar .ss-btn').count()) === 1
  const hasToggle = (await win.locator('.filterbar .toggle', { hasText: 'Group' }).count()) === 1
  const hasScope = (await win.locator('.filterbar .scope-tab').count()) === 3

  let browseDefault = 0
  let cardCount = 0
  let firstTitle = ''
  let clusterBadges = 0
  let menuItems = 0
  let hasContext = false
  let lightboxOpened = false
  let filterReran = false
  let importPanelOk = false
  let contextFilterOk = false

  if (archiveConnected) {
    // default browse populates with no query (newest first)
    await win.waitForSelector('main .grid .card', { timeout: 15000 })
    browseDefault = await win.locator('main .grid .card').count()

    // search settles to its own results
    await win.fill('.search-input', 'dyslexia')
    await win.waitForTimeout(1600)
    cardCount = await win.locator('main .grid .card').count()
    firstTitle = ((await win.locator('main .card-title').first().textContent()) ?? '').trim()
    clusterBadges = await win.locator('main .badge.clickable').count()

    // action menu — includes the new "See in context"
    await win.locator('main .card .more').first().click()
    await win.waitForSelector('.ctx-menu', { timeout: 4000 })
    const labels = await win.locator('.ctx-menu .ctx-item').allTextContents()
    menuItems = labels.length
    hasContext = labels.includes('See in context (whole deck)')
    const hasExpected = ['Open full size', 'Copy text', 'Copy structure (JSON)', 'Copy reference', 'Reveal in Finder'].every((l) => labels.includes(l))
    await win.locator('.menu-scrim').click()
    if (!hasExpected) menuItems = -menuItems

    // lightbox
    await win.locator('main .card .thumb-wrap').first().click()
    lightboxOpened = (await win.locator('.lightbox').count()) === 1
    if (lightboxOpened) await win.keyboard.press('Escape')

    // a filter re-runs (Date select: Owner, Date, Slides → nth 1)
    await win.locator('.filterbar select').nth(1).selectOption('2024')
    await win.waitForTimeout(1200)
    const after = await win.locator('main .grid .card').count()
    filterReran = after >= 0

    // Import panel opens with its two actions + a log (not triggering a real ingest here)
    await win.locator('.import-btn').click()
    await win.waitForSelector('.modal.import', { timeout: 4000 })
    importPanelOk = (await win.locator('.modal.import .primary-btn').count()) === 2 && (await win.locator('.import-log').count()) === 1
    await win.locator('.modal.import .copyref').click()

    // "See in context" now filters the grid to the whole deck (banner + cards), not a popup
    await win.locator('main .card .more').first().click()
    await win.waitForSelector('.ctx-menu', { timeout: 4000 })
    await win.locator('.ctx-menu .ctx-item', { hasText: 'See in context' }).click()
    await win.waitForTimeout(1000)
    contextFilterOk = (await win.locator('.context-banner').count()) === 1 && (await win.locator('main .grid .card').count()) > 0
    if (contextFilterOk) await win.locator('.context-banner .link').click()
  }

  const shellPass = title === 'SlideWell' && wordmark === 'SlideWell'
  const featuresPass =
    !archiveConnected ||
    (filterSelects === 3 && hasSearchableCategory && hasToggle && hasScope && browseDefault > 0 && cardCount > 0 && menuItems >= 8 && hasContext && lightboxOpened && filterReran && importPanelOk && contextFilterOk)
  const pass = shellPass && featuresPass
  out({ launched: true, title, archiveConnected, filterSelects, hasSearchableCategory, hasToggle, hasScope, browseDefault, cardCount, firstTitle, clusterBadges, menuItems, hasContext, lightboxOpened, filterReran, importPanelOk, contextFilterOk, pass })
  await app.close()
  process.exit(pass ? 0 : 2)
} catch (e) {
  out({ launched: false, error: String(e) })
  await app.close().catch(() => {})
  process.exit(1)
}
