// End-to-end: "More like this" in the inspector. Needs an indexed profile (model downloaded, sample
// archive indexed) like e2e/match-switch.mjs.
//
// Run after `npm run build`:
//   SLIDEWELL_MLT_SCRATCH=<folder holding userData/ (with models/), well/, home/ and sample-archive/> \
//   node e2e/more-like-this.mjs
// Screenshots go to <scratch>/screens (hidden run). Every launch is SLIDEWELL_E2E_HIDDEN=1 with its own
// user-data-dir; never touches the installed app.
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const scratch = process.env.SLIDEWELL_MLT_SCRATCH
if (!scratch || !existsSync(join(scratch, 'userData', 'models'))) {
  console.error('Set SLIDEWELL_MLT_SCRATCH to a folder with userData/models, well/ and sample-archive/.')
  process.exit(2)
}
const query = process.env.SLIDEWELL_MLT_QUERY || 'research'
const screens = join(scratch, 'screens')
mkdirSync(screens, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) failed++
}
function profile(name) {
  const userData = join(scratch, name === 'main' ? 'userData' : name)
  if (name !== 'main') {
    rmSync(userData, { recursive: true, force: true })
    mkdirSync(userData, { recursive: true })
  }
  writeFileSync(join(userData, 'config.json'), JSON.stringify({ archiveRoot: join(scratch, 'sample-archive'), wellRoot: join(scratch, 'well'), othersArchiveRoot: join(scratch, 'others') }), 'utf8')
  return userData
}
async function launch(userData) {
  const home = join(scratch, 'home')
  mkdirSync(home, { recursive: true })
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env: { ...process.env, HOME: home, SLIDEWELL_E2E_HIDDEN: '1' } })
  let win = null
  for (let i = 0; i < 300 && !win; i++) {
    win = app.windows().find((w) => !w.url().startsWith('swembed:') && w.url() !== 'about:blank') ?? null
    if (!win) await sleep(100)
  }
  if (!win) throw new Error('main window did not open')
  await win.waitForLoadState('domcontentloaded')
  return { app, win }
}
async function openInspectorOnFirstSlide(win) {
  await win.locator('.filterbar select').nth(0).selectOption('all') // the sample's presentations have no owner recorded
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
let { app, win } = await launch(profile('main'))
try {
  for (let i = 0; i < 120; i++) {
    const st = await win.evaluate(() => window.sw.picture.status())
    if (st.model === 'ready' && st.index.phase !== 'indexing') break
    await sleep(500)
  }
  await openInspectorOnFirstSlide(win)
  const btn = win.locator('.more-like-this .primary-btn')
  check('button is enabled with the model', !(await btn.isDisabled()))
  check('hint names what it does', (await win.locator('.mlt-hint').innerText()).includes('other presentations'))
  // The sample indexes only part of the archive, so walk the cards until one is indexed; those walked past
  // are real "not indexed yet" items.
  const cards = win.locator('.card')
  let found = false
  let sawNotIndexed = false
  for (let i = 0; i < Math.min(await cards.count(), 40) && !found; i++) {
    await cards.nth(i).click()
    await sleep(150)
    await btn.click()
    await win.waitForFunction(() => document.querySelector('.mlt-item') || /not indexed yet/i.test(document.querySelector('.mlt-hint')?.textContent ?? ''), null, { timeout: 15000 })
    if (await win.locator('.mlt-item').count()) found = true
    else if (!sawNotIndexed) {
      sawNotIndexed = true
      check('real unindexed item shows the quiet "not indexed yet" hint, no error', /not indexed yet/i.test(await win.locator('.mlt-hint').innerText()) && (await win.locator('.mlt-hint.quiet').count()) === 1)
      await win.screenshot({ path: join(screens, 'more-like-this-not-indexed.png') })
    }
  }
  check('found an indexed item with results', found)
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
  check(`results never include the item or its presentation (${sweep.checked} items checked)`, sweep.checked > 0 && sweep.bad.length === 0, sweep.bad.join('; '))

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
;({ app, win } = await launch(profile('no-model')))
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
process.exit(failed ? 1 : 0)
