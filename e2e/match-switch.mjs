// Hidden end-to-end: Words / Meaning / Both against a generated archive.
// Run npm run test:match-switch with SLIDEWELL_PICTURE_MODEL_DIR pointing to a verified local cache.
import { finish, recordFailure } from './support/result.mjs'
import { createScratch, launchHidden } from './support/scratch.mjs'
import { copyCachedPictureModel, requireCachedPictureModel } from './support/cached-picture-model.mjs'
import { makeSearchArchive, writeSearchProfile, waitForSearchIndex, WORDS_QUERY, NO_WORDS_QUERY } from './support/search-fixture.mjs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const model = requireCachedPictureModel('SLIDEWELL_PICTURE_MODEL_DIR', 'SLIDEWELL_SORTER_MODEL_DIR')
const scratch = createScratch('match')
const expected = await makeSearchArchive(join(scratch, 'archive'), { includeUnrendered: false })
const modelProfile = join(scratch, 'userData')
copyCachedPictureModel(model, modelProfile)
const wordsQuery = WORDS_QUERY
const noWordsQuery = NO_WORDS_QUERY
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
const search = async (win, text) => {
  await win.locator('.searchbar .search-input').fill(text)
  await sleep(700) // debounce + query
  await win.waitForFunction(() => !document.querySelector('.results-head')?.textContent?.includes('loading'), null, { timeout: 60000 })
  await sleep(300)
}
const matchTab = (win, name) => win.locator('[aria-label="Match"] .scope-tab', { hasText: name })
const allOwners = (win) => win.locator('.filterbar select').nth(0).selectOption('all')
const queries = (win) => win.evaluate(() => window.sw.picture.queryCount())
const bandHeads = (win) => win.locator('.band-toggle').allInnerTexts()
const chips = (win) => win.locator('.card .score-chip').allInnerTexts()

// ---------- run 1: model present ----------
let { app, win } = await launch(profile(modelProfile))
try {
  await waitForSearchIndex(win, expected)
  await allOwners(win)
  check('Both is the default', (await matchTab(win, 'Both').getAttribute('aria-selected')) === 'true')
  check('Meaning and Both are enabled with the model', !(await matchTab(win, 'Meaning').isDisabled()) && !(await matchTab(win, 'Both').isDisabled()))

  // Both: two bands, scores on every card, a hit found both ways only in the Words band
  let q0 = await queries(win)
  await search(win, wordsQuery)
  await win.locator('.band-toggle', { hasText: 'Looks related' }).waitFor()
  const heads = await bandHeads(win)
  console.log('bands:', JSON.stringify(heads))
  check('Both ran one picture query', (await queries(win)) === q0 + 1, `${q0} -> ${await queries(win)}`)
  check('Words match band above Looks related band', /^.? ?Words match \(\d+\)/.test(heads[0] ?? '') && /Looks related \(\d+\)/.test(heads[1] ?? ''), JSON.stringify(heads))
  const c = await chips(win)
  check('every card shows one score label form', c.length > 0 && c.every((t) => /^(words|meaning) \d\.\d\d$/.test(t)), JSON.stringify(c.slice(0, 5)))
  const nWords = Number(heads[0]?.match(/\((\d+)\)/)?.[1])
  const nRel = Number(heads[1]?.match(/\((\d+)\)/)?.[1])
  const cards = await win.locator('.card').count()
  const shown = Math.min(nRel, 10)
  check('cards = words + related shown', cards === nWords + shown, `${cards} vs ${nWords}+${shown}`)
  check('word cards say words, related cards say meaning', c.slice(0, nWords).every((t) => t.startsWith('words')) && c.slice(nWords).every((t) => t.startsWith('meaning')))
  const titles = await win.locator('.card .card-foot .deck').allInnerTexts()
  check('no card twice (dedupe across bands)', new Set(titles).size === titles.length)
  await win.screenshot({ path: join(screens, 'match-both.png') })
  await win.locator('.band-toggle', { hasText: 'Looks related' }).scrollIntoViewIfNeeded()
  await win.screenshot({ path: join(screens, 'match-both-related-band.png') })

  // Words only: fast path, no picture query, quiet hint
  q0 = await queries(win)
  await matchTab(win, 'Words').click()
  await sleep(800)
  await search(win, wordsQuery + ' ')
  await search(win, wordsQuery)
  check('Words made no picture query (main-process counter)', (await queries(win)) === q0, `${q0} -> ${await queries(win)}`)
  check('Words shows no related band', (await bandHeads(win)).length === 0)
  check('Words shows the quiet hint', (await win.locator('.match-note').first().innerText().catch(() => '')).startsWith('Words only'))
  check('Words cards still carry words scores', (await chips(win)).every((t) => /^words \d\.\d\d$/.test(t)))
  await win.screenshot({ path: join(screens, 'match-words-only.png') })

  // Both again, query with no word match
  await matchTab(win, 'Both').click()
  await sleep(500)
  await search(win, noWordsQuery)
  await win.locator('.match-note.info').waitFor()
  const heads2 = await bandHeads(win)
  console.log('bands (no word match):', JSON.stringify(heads2))
  check('no word match: Words match (0) and a populated Looks related band', /Words match \(0\)/.test(heads2[0] ?? '') && /Looks related \([1-9]\d*\)/.test(heads2[1] ?? ''), JSON.stringify(heads2))
  const note = await win.locator('.match-note.info').innerText().catch(() => '')
  check('no word match: one-line note', /contains these words — showing .* that look related/.test(note), note)
  check('no word match: related cards say meaning', (await chips(win)).length > 0 && (await chips(win)).every((t) => t.startsWith('meaning')))
  await win.screenshot({ path: join(screens, 'match-no-word-match.png') })

  // Meaning alone
  await matchTab(win, 'Meaning').click()
  await win.locator('.band-toggle', { hasText: 'Words match' }).waitFor({ state: 'detached' })
  await win.locator('.band-toggle', { hasText: 'Looks related' }).waitFor()
  check('Meaning shows only the related band', (await bandHeads(win)).length === 1 && /Looks related/.test((await bandHeads(win))[0]))
} finally {
  await app.close()
}

// ---------- run 2: no model ----------
;({ app, win } = await launch(profile(join(scratch, 'no-model'))))
try {
  await sleep(1500)
  await allOwners(win)
  const st = await win.evaluate(() => window.sw.picture.status())
  check('profile has no model', st.model === 'absent', st.model)
  check('Meaning and Both are disabled without the model', (await matchTab(win, 'Meaning').isDisabled()) && (await matchTab(win, 'Both').isDisabled()))
  check('Words is the active choice', (await matchTab(win, 'Words').getAttribute('aria-selected')) === 'true')
  check('Settings link shown', (await win.locator('.match-settings').count()) === 1)
  await search(win, wordsQuery)
  const n = await win.locator('.card').count()
  check('search still returns word results', n > 0, `${n} cards`)
  check('no picture query ran', (await queries(win)) === 0)
  await win.screenshot({ path: join(screens, 'match-no-model.png') })
  const [sw] = await Promise.all([app.waitForEvent('window', { timeout: 10000 }), win.locator('.match-settings').click()])
  await sw.waitForSelector('.bsw-root', { timeout: 10000 })
  await sw.locator('.pic-settings h3').waitFor({ timeout: 10000 })
  check('the link opens the Settings window at Picture search', sw.url().endsWith('settings.html') && (await sw.locator('.pic-settings h3').count()) === 1)
} finally {
  await app.close()
}
console.log(failed ? 'MATCH SWITCH E2E: FAILED' : 'MATCH SWITCH E2E: PASSED')
finish(failed ? 'assertion failed' : null)
