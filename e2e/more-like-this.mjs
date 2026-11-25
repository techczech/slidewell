// Hidden end-to-end: the More like this inspector against a generated archive.
// Run npm run test:more-like-this with SLIDEWELL_PICTURE_MODEL_DIR pointing to a verified local cache.
import { finish, recordFailure } from './support/result.mjs'
import { createScratch, launchHidden } from './support/scratch.mjs'
import { copyCachedPictureModel, requireCachedPictureModel } from './support/cached-picture-model.mjs'
import { makeSearchArchive, writeSearchProfile, waitForSearchIndex, WORDS_QUERY, UNRENDERED_TITLE } from './support/search-fixture.mjs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const model = requireCachedPictureModel('SLIDEWELL_PICTURE_MODEL_DIR', 'SLIDEWELL_SORTER_MODEL_DIR')
const scratch = createScratch('more')
const expected = await makeSearchArchive(join(scratch, 'archive'), { includeUnrendered: true })
const modelProfile = join(scratch, 'userData')
copyCachedPictureModel(model, modelProfile)
const query = WORDS_QUERY
const screens = join(scratch, 'screens')
mkdirSync(screens, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) {
    recordFailure(name)
    failed++
  }
}
function profile(userData) {
  writeSearchProfile(scratch, userData)
  return userData
}
async function launch(userData) {
  const home = join(scratch, 'home')
  mkdirSync(home, { recursive: true })
  const app = await launchHidden(userData, home, { isolatePreferences: true })
  try {
    let win = null
    for (let i = 0; i < 300 && !win; i++) {
      win = app.windows().find((w) => !w.url().startsWith('swembed:') && w.url() !== 'about:blank') ?? null
      if (!win) await sleep(100)
    }
    if (!win) throw new Error('main window did not open')
    await win.waitForLoadState('domcontentloaded')
    return { app, win }
  } catch (error) {
    await app.close().catch(() => undefined)
    throw error
  }
}
async function openInspectorOnFirstSlide(win) {
  await win.locator('.filterbar select').nth(0).selectOption('all')
  await win.locator('.searchbar .search-input').fill(query)
  await sleep(700)
  await win.waitForFunction(() => !document.querySelector('.results-head')?.textContent?.includes('loading'), null, { timeout: 60000 })
  await sleep(300)
  await win.locator('.card').first().click()
  await win.locator('.card').first().press('i').catch(() => undefined)
  await win.waitForSelector('.deck-sidebar', { timeout: 5000 }).catch(async () => {
    await win.keyboard.press('i')
    await win.waitForSelector('.deck-sidebar', { timeout: 5000 })
  })
}

// ---------- run 1: model present ----------
let { app, win } = await launch(profile(modelProfile))
try {
  await waitForSearchIndex(win, expected)
  await openInspectorOnFirstSlide(win)
  const btn = win.locator('.more-like-this .primary-btn')
  // The inspector reads model status over IPC after mounting.
  await btn.and(win.locator('button:enabled')).waitFor({ timeout: 10000 })
  check('button is enabled with the model', !(await btn.isDisabled()))
  check('hint names what it does', (await win.locator('.mlt-hint').innerText()).includes('other presentations'))
  const unrendered = win.locator('.card').filter({ has: win.getByText(UNRENDERED_TITLE, { exact: true }) })
  await unrendered.click()
  await btn.click()
  await win.locator('.mlt-hint.quiet').filter({ hasText: /not indexed yet/i }).waitFor()
  check('real unindexed item shows the quiet "not indexed yet" hint, no error', await win.locator('.mlt-hint.quiet').count() === 1)
  await win.screenshot({ path: join(screens, 'more-like-this-not-indexed.png') })

  const indexed = win.locator('.card').filter({ hasText: 'Lantern survey 1.1' })
  await indexed.click()
  await btn.click()
  await win.locator('.mlt-item').first().waitFor()
  check('found an indexed item with results', await win.locator('.mlt-item').count() > 0)
  const title0 = await win.locator('.deck-sidebar-head b').innerText()
  const deck0 = (await win.locator('.drow:has(.dk:text-is("Presentation")) .dv').innerText()).trim()
  const n = await win.locator('.mlt-item').count()
  check('at most six results, at least one', n >= 1 && n <= 6, `got ${n}`)
  const chipTexts = await win.locator('.mlt-item .score-chip').allInnerTexts()
  check('every result has a score badge (0-1)', chipTexts.length === n && chipTexts.every((c) => /^\d\.\d\d$/.test(c.trim())), chipTexts.join(','))
  const sorted = [...chipTexts].map(Number).sort((a, b) => b - a)
  check('best score first', chipTexts.map(Number).every((v, i) => v === sorted[i]))
  await win.screenshot({ path: join(screens, 'more-like-this-results.png') })

  // exclusion rule against the engine: every indexed slide, none of the results is the item or from its presentation
  const sweep = await win.evaluate(async (q) => {
    const ids = (await window.sw.picture.query({ text: q }, { limit: 500, kinds: ['slide'] })).results.map((r) => r.id)
    let checked = 0
    const bad = []
    for (const id of ids) {
      const m = id.match(/^slide:(.+)#(\d+)$/)
      const h = { kind: 'slide', deck: m[1], slideOrder: Number(m[2]), reference: '' }
      const r = await window.sw.archive.moreLikeThis(h)
      checked++
      if (r.state !== 'ok' || r.items.length > 6 || r.items.some((i) => i.deck === h.deck && i.slideOrder === h.slideOrder) || r.items.some((i) => i.deck === h.deck)) bad.push(`${id}:${r.state}:${r.items.map((i) => i.deck).join('|')}`)
    }
    return { checked, bad }
  }, query)
  check(`results never include the item or its presentation (${sweep.checked} items checked)`, sweep.checked === expected && sweep.bad.length === 0, sweep.bad.join('; '))

  // clicking a result opens it in the inspector
  await win.locator('.mlt-item').first().click()
  await sleep(500)
  const title1 = await win.locator('.deck-sidebar-head b').innerText()
  check('clicking a result opens it in the inspector', (await win.locator('.inspector-pos').innerText()).includes('opened from More like this'))
  check('the inspector now shows a different item', title1 !== title0 || (await win.locator('.drow:has(.dk:text-is("Presentation")) .dv').innerText()).trim() !== deck0)
  await win.screenshot({ path: join(screens, 'more-like-this-opened.png') })
  await win.locator('.inspector-pos .link').click()
  await sleep(300)
  check('back to the list restores the selected card', (await win.locator('.deck-sidebar-head b').innerText()) === title0)

  // not indexed yet: a slide id with no stored vector gives a quiet state, not an error
  const ni = await win.evaluate(() => window.sw.archive.moreLikeThis({ kind: 'slide', deck: 'no-such-presentation', slideOrder: 1, reference: '' }))
  check('unknown item -> not-indexed', ni.state === 'not-indexed' && ni.items.length === 0, JSON.stringify(ni))
} finally {
  await app.close()
}

// ---------- run 2: model missing ----------
;({ app, win } = await launch(profile(join(scratch, 'no-model'))))
try {
  await openInspectorOnFirstSlide(win)
  const btn = win.locator('.more-like-this .primary-btn')
  check('no model: button disabled', await btn.isDisabled())
  const hintText = await win.locator('.mlt-hint').innerText()
  check('no model: hint says where to get it', /model/i.test(hintText) && /settings/i.test(hintText), hintText)
  await win.screenshot({ path: join(screens, 'more-like-this-no-model.png') })
} finally {
  await app.close()
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS')
finish(failed ? 'assertion failed' : null)
