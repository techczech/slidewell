// Hidden end-to-end: index a generated archive, restart while paused, recover after a hard kill,
// and verify a new well image plus text and image queries.
// Run npm run test:picture-search with SLIDEWELL_PICTURE_MODEL_DIR pointing to a verified local cache.
import { finish, recordFailure } from './support/result.mjs'
import { createScratch, launchHidden } from './support/scratch.mjs'
import { copyCachedPictureModel, requireCachedPictureModel } from './support/cached-picture-model.mjs'
import { makeSearchArchive, writeSearchProfile, NO_WORDS_QUERY, WORDS_QUERY } from './support/search-fixture.mjs'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

const model = requireCachedPictureModel('SLIDEWELL_PICTURE_MODEL_DIR', 'SLIDEWELL_SORTER_MODEL_DIR')
const expectId = process.env.SLIDEWELL_PICTURE_EXPECT || null
const queryText = process.env.SLIDEWELL_PICTURE_QUERY || NO_WORDS_QUERY
const scratch = createScratch('picture')
const sample = join(scratch, 'archive')
const userData = join(scratch, 'userData')
const home = join(scratch, 'home')
const well = join(scratch, 'well')
const screens = join(scratch, 'screens')
const storeFile = join(well, 'picture-search.db')
const expected = await makeSearchArchive(sample, { slidesPerDeck: 12 })

mkdirSync(screens)
copyCachedPictureModel(model, userData)
writeSearchProfile(scratch, userData)

const results = {}
const out = (k, v) => {
  results[k] = v
  console.log(`${k}: ${JSON.stringify(v)}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const FILTERS = { owner: 'all', era: 'all', category: '', deck: '', role: 'content', cluster: true, from: 'all', kind: 'all', type: 'slides', library: 'mine' }

async function launch() {
  // SLIDEWELL_E2E_HIDDEN: no window is shown and nothing takes focus (screenshots still render)
  const app = await launchHidden(userData, home, { isolatePreferences: true })
  try {
    // Block and record every HTTP(S) request in this session.
    await app.evaluate(({ session }) => {
      globalThis.__requests = []
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (d, cb) => {
        globalThis.__requests.push(d.url)
        cb({ cancel: true })
      })
    })
    // the main window, not the hidden picture-search window (swembed://), which may open first
    let win = null
    for (let i = 0; i < 300 && !win; i++) {
      win = app.windows().find((w) => !w.url().startsWith('swembed:') && w.url() !== 'about:blank') ?? null
      if (!win) await sleep(100)
    }
    if (!win) throw new Error('main window did not open')
    currentApp = app
    await win.waitForLoadState('domcontentloaded')
    return { app, win }
  } catch (error) {
    await app.close().catch(() => undefined)
    throw error
  }
}
const status = (win) => win.evaluate(() => window.sw.picture.status())
// hidden run: no window visible or focused, ever (sampled at each checkpoint and on every status poll)
let windowShown = null
async function noteVisibility(app) {
  const ws = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ url: w.webContents.getURL(), visible: w.isVisible(), focused: w.isFocused() }))).catch(() => [])
  const bad = ws.find((w) => w.visible || w.focused)
  if (bad && !windowShown) windowShown = bad
}
// The gear opens the one Settings window (as e2e/settings.mjs does); returns it at the Picture search page.
async function openSettings(app, win) {
  const [sw] = await Promise.all([app.waitForEvent('window', { timeout: 10000 }), win.locator('.titlebar-actions .tb-btn', { hasText: '⚙' }).click()])
  await sw.waitForSelector('.bsw-root', { timeout: 10000 })
  await sw.locator('button.bsw-nav[data-section="picture-search"]').click()
  await sw.locator('.pic-settings h3').waitFor()
  return sw
}
const closeSettings = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.getURL().endsWith('settings.html') && w.close())).catch(() => {})
const requests = (app) => app.evaluate(() => globalThis.__requests)
let currentApp = null
async function waitFor(win, pred, timeoutMs, label) {
  const t0 = Date.now()
  for (;;) {
    if (currentApp) await noteVisibility(currentApp)
    const st = await status(win)
    if (st.index.phase === 'error') throw new Error(`fixture indexing failed: ${st.index.error}`)
    if (pred(st)) return st
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(st)}`)
    await sleep(100)
  }
}
const vectorRows = () => {
  if (!existsSync(storeFile)) return []
  const db = new DatabaseSync(storeFile, { readOnly: true })
  try {
    return db.prepare('SELECT id, embedded_at FROM vectors').all()
  } finally {
    db.close()
  }
}
const statusBar = async (win) => (await win.locator('.statusbar').textContent())?.replace(/\s+/g, ' ').trim()
async function wordSearchMs(win, n = 5) {
  const times = []
  for (let i = 0; i < n; i++) {
    const t = await win.evaluate(async ([text, filters]) => {
      const t0 = performance.now()
      await window.sw.archive.search(text, filters)
      return performance.now() - t0
    }, [WORDS_QUERY, FILTERS])
    times.push(Math.round(t))
  }
  return times.sort((a, b) => a - b)[Math.floor(n / 2)]
}

let failed = false
const check = (name, ok, detail) => {
  out(`check ${name}`, ok ? 'pass' : `FAIL ${detail ?? ''}`)
  if (!ok) {
    recordFailure(name)
    failed = true
  }
}

// ---------- run 1: local model ready, index and pause ----------
let { app, win } = await launch()
try {
  const st0 = await status(win)
  check('cached model is ready', st0.model === 'ready', st0.model)
  const sw = await openSettings(app, win)
  await noteVisibility(app)
  const note = (await sw.locator('.pic-note').textContent())?.trim()
  out('settings note', note)
  check('well images on by default', await sw.locator('.pic-check input').isChecked())
  // indexing starts by itself; pause from the status bar once a few are done
  await waitFor(win, (s) => s.index.phase === 'indexing' && s.index.done >= 5, 120000, 'indexing under way')
  await closeSettings(app) // the Settings window was left open so far; indexing carries on in the main window
  out('status bar while indexing', await statusBar(win))
  results.busyMs = await wordSearchMs(win)
  out('word search ms during indexing (median of 5)', results.busyMs)
  await win.screenshot({ path: join(screens, 'S3-status-indexing.png') })
  await win.locator('.statusbar .pic-btn', { hasText: 'Pause' }).click()
  const paused = await waitFor(win, (s) => s.index.phase === 'paused', 15000, 'paused')
  out('paused at', `${paused.index.done} / ${paused.index.total}`)
  check('pause stops mid-run', paused.index.done > 0 && paused.index.done < paused.index.total)
  await win.screenshot({ path: join(screens, 'S3-status-paused.png') })
  check('no network request during indexing and pause', (await requests(app)).length === 0)
} finally {
  await app.close()
}
const afterPause = vectorRows()

// ---------- run 2: pause survives restart; resume; then hard kill mid-run ----------
;({ app, win } = await launch())
let beforeKill = []
try {
  const st = await waitFor(win, (s) => s.index.phase === 'paused' && s.index.total > 0, 30000, 'paused after restart')
  await sleep(2500)
  const still = await status(win)
  check('pause survives restart', still.index.phase === 'paused' && vectorRows().length === afterPause.length, `${still.index.phase} ${vectorRows().length}/${afterPause.length}`)
  out('status bar after restart', await statusBar(win))
  await win.locator('.statusbar .pic-btn', { hasText: 'Resume' }).click()
  const target = st.index.done + 5
  await waitFor(win, (s) => s.index.done >= target, 120000, 'resumed progress')
  beforeKill = vectorRows()
  out('vectors at hard kill', beforeKill.length)
  check('hard kill interrupts an unfinished index', beforeKill.length > 0 && beforeKill.length < expected)
  check('no network request during resume', (await requests(app)).length === 0)
} finally {
  app.process().kill('SIGKILL')
  await sleep(1000)
}

// ---------- run 3: resume after the kill, finish, new well image, queries ----------
;({ app, win } = await launch())
try {
  const total = (await waitFor(win, (s) => s.index.total > 0, 30000, 'plan after kill')).index.total
  const first = await status(win)
  out('first status after kill', `${first.index.phase} ${first.index.done} / ${total}`)
  check('resumes where it stopped (no restart from zero)', first.index.done >= beforeKill.length - 1, `${first.index.done} vs ${beforeKill.length}`)
  const done = await waitFor(win, (s) => s.index.phase === 'done', 10 * 60 * 1000, 'indexing done')
  const rows = vectorRows()
  const before = new Map(beforeKill.map((r) => [r.id, r.embedded_at]))
  const reembedded = rows.filter((r) => before.has(r.id) && before.get(r.id) !== r.embedded_at).length
  out('final', `${done.index.done} / ${done.index.total}, failed ${done.index.failed}, vectors ${rows.length}`)
  check('all sample images indexed', done.index.done === expected && done.index.total === expected && done.index.failed === 0 && rows.length === expected)
  check('nothing embedded twice across restarts', reembedded === 0, `${reembedded} re-embedded`)
  const idleMs = await wordSearchMs(win)
  out('word search ms idle (median of 5)', idleMs)
  // word search must stay responsive while indexing: under 250 ms and within 10× the idle time
  check('word search responsive during indexing', results.busyMs <= 250 && results.busyMs <= 10 * Math.max(1, idleMs), `${results.busyMs} ms busy vs ${idleMs} ms idle`)

  // a new well image arrives (dropped into the well inbox) → embedded without a restart
  const someRender = join(sample, 'extracted', 'fixture-deck-1', 'renders', 'slide_0001.webp')
  copyFileSync(someRender, join(well, '_inbox', 'new-arrival.webp'))
  const t0 = Date.now()
  let wellVec = null
  while (Date.now() - t0 < 60000 && !wellVec) {
    wellVec = vectorRows().find((r) => r.id.startsWith('well:'))
    await sleep(250)
  }
  check('new well image embedded as it arrives', Boolean(wellVec), 'no well: vector within 60 s')
  out('new well image embedded after seconds', wellVec ? Math.round((Date.now() - t0) / 100) / 10 : null)

  const q = await win.evaluate((t) => window.sw.picture.query({ text: t }, { limit: 5 }), queryText)
  out(`query "${queryText}"`, q.results.map((r) => `${r.id} ${r.score.toFixed(3)}`))
  const firstId = q.results[0]?.id
  check('text query returns five ranked results', q.ok && q.results.length === 5 && q.results.every((row, i) => i === 0 || row.score <= q.results[i - 1].score), q.error)
  if (!firstId) throw new Error(q.error || 'text query returned no image to query by id')
  if (expectId) check('expected slide ranks first', firstId === expectId, firstId)
  const sim = await win.evaluate((id) => window.sw.picture.query({ imageId: id }, { limit: 3 }), firstId)
  check('more-like-this query by image id', sim.ok && sim.results.length === 3 && !sim.results.some((r) => r.id === q.results[0].id))

  check('no network request during final queries', (await requests(app)).length === 0)
} finally {
  await app.close()
}
check('no window shown or focused during the run', windowShown === null, JSON.stringify(windowShown))
out('screenshots', screens)
console.log(failed ? 'PICTURE SEARCH E2E: FAILED' : 'PICTURE SEARCH E2E: PASSED')
finish(failed ? 'assertion failed' : null)
