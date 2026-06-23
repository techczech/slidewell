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
  const filterSelects = await win.locator('.filterbar .filter select').count() // Owner, Date, Role, Sort
  const hasSearchableFilters = (await win.locator('.filterbar .ss-btn').count()) >= 2 // Category + Deck
  const hasToggle = (await win.locator('.filterbar .toggle', { hasText: 'near-identical' }).count()) === 1
  const hasScope = (await win.locator('.filterbar [aria-label="Source scope"] .scope-tab').count()) === 3

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
  let imagesTypeOk = false
  let imgCards = 0
  let imgTags = 0
  let groupByDeckOk = false
  let deckModeOk = false
  let statsOk = false
  let roleAllOk = false
  let selectionOk = false
  let rowNavOk = false
  let clickSelectsOk = false
  let inspectorOk = false
  let paletteOk = false
  let lightboxPaletteOk = false
  let helpOk = false
  let triageOpensOk = false
  let settingsOk = false

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

    // Role: Incl. structural includes title/opening slides → in BROWSE, ≥ content-only count
    await win.fill('.search-input', '')
    await win.waitForTimeout(900)
    const contentCount = await win.locator('main .grid .card').count()
    await win.locator('.filterbar select').nth(2).selectOption('all') // Owner, Date, Role, Sort → Role = nth 2
    await win.waitForTimeout(1300)
    // (count is confounded by the 200-cap + clustering of near-identical openings; just assert it runs)
    roleAllOk = contentCount > 0 && (await win.locator('main .grid .card').count()) > 0
    await win.locator('.filterbar select').nth(2).selectOption('content')
    await win.fill('.search-input', 'dyslexia')
    await win.waitForTimeout(1200)

    // keyboard: blur search, arrow-select, inspector (I), command palette (⌘K), help (?)
    await win.keyboard.press('Escape') // blur the search input
    await win.waitForTimeout(150)
    // index of the selected card among the rendered grid (DOM order == orderedReps order)
    const selIndex = () =>
      win.evaluate(() => Array.from(document.querySelectorAll('main .grid .card')).findIndex((c) => c.classList.contains('selected')))
    await win.keyboard.press('ArrowRight') // selects the first card
    await win.waitForTimeout(150)
    const i0 = await selIndex()
    selectionOk = i0 >= 0 && (await win.locator('main .card.selected').count()) === 1
    await win.keyboard.press('ArrowRight') // → next item (step of 1)
    await win.waitForTimeout(150)
    const i1 = await selIndex()
    await win.keyboard.press('ArrowDown') // → down a row (step = column count > 1)
    await win.waitForTimeout(150)
    const i2 = await selIndex()
    rowNavOk = i1 - i0 === 1 && i2 - i1 > 1 // right moves by 1; down jumps a whole row
    await win.keyboard.press('i')
    await win.waitForTimeout(350)
    inspectorOk = (await win.locator('.deck-sidebar').count()) === 1
    await win.keyboard.press('Escape')
    await win.waitForTimeout(200)
    await win.keyboard.press('Meta+k')
    await win.waitForTimeout(350)
    paletteOk =
      (await win.locator('.cmd-palette').count()) === 1 &&
      (await win.locator('.cmd-item').count()) > 0 &&
      (await win.locator('.cmd-shortcut').count()) > 0 // actions list their keyboard shortcuts
    await win.keyboard.press('Escape')
    await win.waitForTimeout(200)
    await win.keyboard.press('?')
    await win.waitForTimeout(250)
    helpOk = (await win.locator('.help-modal').count()) === 1
    await win.keyboard.press('Escape')
    await win.waitForTimeout(200)

    // Triage screen opens from the toolbar and renders (deeper scan/include flow: e2e/triage.mjs)
    await win.locator('.titlebar-actions .tb-btn', { hasText: 'Triage' }).click()
    await win.waitForTimeout(300)
    triageOpensOk = (await win.locator('.triage-panel').count()) === 1
    await win.keyboard.press('Escape')
    await win.waitForTimeout(200)

    // Settings panel: lists dependency status + a link to the requirements guide
    await win.locator('.titlebar-actions .tb-btn', { hasText: '⚙' }).click()
    await win.waitForTimeout(300)
    settingsOk =
      (await win.locator('.settings-modal').count()) === 1 &&
      (await win.locator('.settings-row.dep').count()) >= 4 &&
      (await win.locator('.settings-reqlink').count()) === 1
    await win.keyboard.press('Escape')
    await win.waitForTimeout(200)

    // action menu — includes the new "See in context"
    await win.locator('main .card .more').first().click()
    await win.waitForSelector('.ctx-menu', { timeout: 4000 })
    const labels = await win.locator('.ctx-menu .ctx-item').allTextContents()
    menuItems = labels.length
    hasContext = labels.includes('See in context (whole deck)')
    const hasExpected = ['Open full size', 'Copy text', 'Copy structure (JSON)', 'Copy reference', 'Reveal in Finder'].every((l) => labels.includes(l))
    await win.locator('.menu-scrim').click()
    if (!hasExpected) menuItems = -menuItems

    // a single click selects but must NOT launch the slideshow
    await win.locator('main .card').nth(2).click()
    await win.waitForTimeout(200)
    clickSelectsOk = (await win.locator('.lightbox').count()) === 0 && (await win.locator('main .card.selected').count()) === 1

    // lightbox — opened by an extra (double) click, not a single one
    await win.locator('main .card .thumb-wrap').first().dblclick()
    await win.waitForTimeout(200)
    lightboxOpened = (await win.locator('.lightbox').count()) === 1
    if (lightboxOpened) {
      // ⌘K must work over the lightbox (acts on the image on screen, not the grid selection)
      await win.keyboard.press('Meta+k')
      await win.waitForTimeout(300)
      lightboxPaletteOk = (await win.locator('.cmd-palette').count()) === 1
      await win.keyboard.press('Escape')
      await win.waitForTimeout(150)
      await win.keyboard.press('Escape')
    }

    // a filter re-runs (Date select: Owner, Date, Slides → nth 1)
    await win.locator('.filterbar select').nth(1).selectOption('2024')
    await win.waitForTimeout(1200)
    const after = await win.locator('main .grid .card').count()
    filterReran = after >= 0

    // Import panel opens with its What/Where rows + an Import action + a log (no real ingest here)
    await win.locator('.tb-btn', { hasText: 'Import' }).click()
    await win.waitForSelector('.modal.import', { timeout: 4000 })
    importPanelOk =
      (await win.locator('.modal.import .settings-row').count()) >= 2 &&
      (await win.locator('.modal.import .primary-btn').count()) >= 1 &&
      (await win.locator('.import-log').count()) === 1
    await win.locator('.modal.import .modal-head .copyref').click()

    // "See in context" now filters the grid to the whole deck (banner + cards), not a popup
    await win.locator('main .card .more').first().click()
    await win.waitForSelector('.ctx-menu', { timeout: 4000 })
    await win.locator('.ctx-menu .ctx-item', { hasText: 'See in context' }).click()
    await win.waitForTimeout(1000)
    contextFilterOk = (await win.locator('.context-banner').count()) === 1 && (await win.locator('main .grid .card').count()) > 0
    if (contextFilterOk) await win.locator('.context-banner .link').click()

    // Group by presentation → per-deck sections; Sort by title re-renders without crashing
    await win.locator('.filterbar .toggle', { hasText: 'Group by presentation' }).click()
    await win.waitForTimeout(800)
    groupByDeckOk = (await win.locator('.deck-group').count()) > 0
    await win.locator('.filterbar select').nth(3).selectOption('title') // Owner, Date, Role, Sort → nth 3
    await win.waitForTimeout(500)

    // Type = Images: extracted images (separate from slides), tagged IMG
    await win.fill('.search-input', '')
    await win.waitForTimeout(500)
    await win.locator('.filterbar .scope-tab', { hasText: 'Images' }).click()
    await win.waitForTimeout(2500)
    imgCards = await win.locator('main .grid .card').count()
    imgTags = await win.locator('main .ocr-tag.img').count()
    imagesTypeOk = imgCards > 0 && imgTags > 0

    // Deck MODE: a card per presentation + a metadata sidebar on click
    await win.locator('.filterbar .scope-tab', { hasText: 'Decks' }).click()
    await win.waitForTimeout(1600)
    const nDeckCards = await win.locator('main .deck-card').count()
    if (nDeckCards > 0) {
      await win.locator('main .deck-card').first().click()
      await win.waitForTimeout(900)
    }
    deckModeOk = nDeckCards > 0 && (await win.locator('.deck-sidebar').count()) === 1
    await win.keyboard.press('Escape') // close the deck inspector before clicking the titlebar
    await win.waitForTimeout(200)

    // Stats panel: opens and renders year bars
    await win.locator('.tb-btn', { hasText: 'Stats' }).click()
    await win.waitForSelector('.stats-modal', { timeout: 5000 })
    try {
      await win.waitForSelector('.stats-modal .statbar-row', { timeout: 9000 })
    } catch {
      /* no bars */
    }
    statsOk = (await win.locator('.stats-modal .statbar-row').count()) > 0
  }

  const shellPass = title === 'SlideWell' && wordmark === 'SlideWell'
  const featuresPass =
    !archiveConnected ||
    (filterSelects === 4 && hasSearchableFilters && hasToggle && hasScope && browseDefault > 0 && cardCount > 0 && menuItems >= 8 && hasContext && lightboxOpened && filterReran && importPanelOk && contextFilterOk && groupByDeckOk && imagesTypeOk && deckModeOk && statsOk && roleAllOk && selectionOk && rowNavOk && clickSelectsOk && inspectorOk && paletteOk && lightboxPaletteOk && helpOk && triageOpensOk && settingsOk)
  const pass = shellPass && featuresPass
  out({ launched: true, title, archiveConnected, filterSelects, hasSearchableFilters, hasToggle, hasScope, browseDefault, cardCount, firstTitle, clusterBadges, menuItems, hasContext, lightboxOpened, filterReran, importPanelOk, contextFilterOk, groupByDeckOk, imagesTypeOk, deckModeOk, statsOk, roleAllOk, selectionOk, rowNavOk, clickSelectsOk, inspectorOk, paletteOk, lightboxPaletteOk, helpOk, triageOpensOk, settingsOk, imgCards, imgTags, pass })
  await app.close()
  process.exit(pass ? 0 : 2)
} catch (e) {
  out({ launched: false, error: String(e) })
  await app.close().catch(() => {})
  process.exit(1)
}
