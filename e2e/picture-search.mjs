// Hidden end-to-end: index a generated archive, restart while paused, recover after a hard kill,
// and verify a new well image plus text and image queries.
// Run npm run test:picture-search with SLIDEWELL_PICTURE_MODEL_DIR pointing to a verified local cache.
// Set SLIDEWELL_PICTURE_DOWNLOAD=1 to download and delete the model through Settings instead.
// Set SLIDEWELL_PICTURE_KEEP_SCRATCH=1 to retain the isolated profile and screenshots for inspection.
import { finish, recordFailure } from './support/result.mjs'
import { createScratch, launchHidden } from './support/scratch.mjs'
import { copyCachedPictureModel, requireCachedPictureModel } from './support/cached-picture-model.mjs'
import { makeSearchArchive, writeSearchProfile } from './support/search-fixture.mjs'
import {
  describePictureSlide, writePictureQueryImage, IMAGE_MATCH_ID, PICTURE_TEXT_QUERY, PICTURE_WORDS_QUERY, TEXT_MATCH_ID
} from './support/picture-search-fixture.mjs'
import { MODEL_DIR_NAME, MODEL_FILES, MODEL_REVISION, MODEL_TOTAL_BYTES, modelFileUrl } from '../src/main/picture-search/model-manifest.ts'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, copyFileSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const download = process.env.SLIDEWELL_PICTURE_DOWNLOAD === '1'
const model = download ? null : requireCachedPictureModel('SLIDEWELL_PICTURE_MODEL_DIR', 'SLIDEWELL_SORTER_MODEL_DIR')
const queryText = process.env.SLIDEWELL_PICTURE_QUERY || PICTURE_TEXT_QUERY
const expectId = process.env.SLIDEWELL_PICTURE_EXPECT || (queryText === PICTURE_TEXT_QUERY ? TEXT_MATCH_ID : null)
const scratch = createScratch('picture', { keep: process.env.SLIDEWELL_PICTURE_KEEP_SCRATCH === '1' })
const sample = join(scratch, 'archive')
const userData = join(scratch, 'userData')
const home = join(scratch, 'home')
const well = join(scratch, 'well')
const screens = join(scratch, 'screens')
const storeFile = join(well, 'picture-search.db')
const modelDir = join(userData, 'models', MODEL_DIR_NAME)
const modelUrls = MODEL_FILES.map(({ path }) => modelFileUrl(path))
console.log(`isolated profile: ${userData}`)
const expected = await makeSearchArchive(sample, { slidesPerDeck: 12, describeSlide: describePictureSlide })

mkdirSync(screens)
if (model) copyCachedPictureModel(model, userData)
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
    // Permit only the pinned files and their HTTPS redirects during the Settings download.
    await app.evaluate(({ session }, pinned) => {
      const allowedFiles = new Set(pinned)
      const redirects = new Map()
      const filter = { urls: ['http://*/*', 'https://*/*'] }
      globalThis.__requests = []
      globalThis.__allowPictureDownload = false
      session.defaultSession.webRequest.onBeforeRequest(filter, (d, cb) => {
        const origin = URL.parse(d.url)?.origin ?? null
        const redirected = redirects.get(d.id) === d.url
        redirects.delete(d.id)
        const file = allowedFiles.has(d.url)
        const allowed = origin !== null && globalThis.__allowPictureDownload && (file || redirected)
        globalThis.__requests.push({ origin, file: file ? d.url : null, allowed })
        if (allowed) redirects.set(d.id, d.url)
        cb({ cancel: !allowed })
      })
      session.defaultSession.webRequest.onBeforeRedirect(filter, (d) => {
        const next = URL.parse(d.redirectURL)
        if (redirects.get(d.id) === d.url && next?.protocol === 'https:' &&
            /(^|\.)(huggingface\.co|hf\.co)$/.test(next.hostname)) {
          redirects.set(d.id, d.redirectURL)
        }
      })
    }, modelUrls)
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
    return db.prepare('SELECT id, embedded_at, vector FROM vectors ORDER BY id').all()
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
    }, [PICTURE_WORDS_QUERY, FILTERS])
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

async function downloadFromSettings(app, win, sw) {
  const downloadButton = sw.getByRole('button', { name: /^Download model \(/ })
  const absent = await status(win)
  check('model absent before Download', absent.model === 'absent' && !existsSync(modelDir), absent.model)
  check('no network request before Download', (await requests(app)).length === 0)
  console.log(`model download target: ${modelDir} (${MODEL_TOTAL_BYTES} bytes)`)
  const start = Date.now()
  await app.evaluate(() => { globalThis.__allowPictureDownload = true })
  await downloadButton.click({ timeout: 10000 })
  await sw.waitForFunction((total) => {
    const progress = document.querySelector('.pic-progress')
    return document.querySelector('.pic-error') ||
      (progress?.max === total && progress.value > 0 && progress.value < total &&
        document.querySelector('.pic-progress-text')?.textContent.startsWith('Downloading '))
  }, MODEL_TOTAL_BYTES, { polling: 100, timeout: 120000 })
  const error = sw.locator('.pic-error')
  if (await error.count()) throw new Error(await error.textContent())
  check('Settings shows download progress', true)
  await waitFor(win, (s) => {
    if (s.error) throw new Error(s.error)
    return s.model === 'ready'
  }, 20 * 60 * 1000, 'downloaded model ready')
  await app.evaluate(() => { globalThis.__allowPictureDownload = false })
  await sw.locator('.pic-settings[data-model="ready"] .pic-ready').waitFor({ timeout: 10000 })
  await sw.getByRole('button', { name: 'Delete model', exact: true }).waitFor({ timeout: 10000 })
  check('Settings shows ready after Download', (await sw.locator('.pic-progress').count()) === 0 && (await downloadButton.count()) === 0)
  const bytes = MODEL_FILES.reduce((sum, { path }) => sum + statSync(join(modelDir, path)).size, 0)
  const marker = JSON.parse(readFileSync(join(modelDir, 'verified.json'), 'utf8'))
  check('downloaded model verified at the pinned revision', bytes === MODEL_TOTAL_BYTES && marker?.revision === MODEL_REVISION,
    `${bytes}/${MODEL_TOTAL_BYTES} bytes, revision ${marker?.revision}, expected ${MODEL_REVISION}`)
  const reqs = await requests(app)
  out('model download', {
    bytes, revision: marker?.revision, seconds: Math.round((Date.now() - start) / 1000),
    origins: [...new Set(reqs.map((r) => r.origin))]
  })
  check('only pinned model files and their redirects requested', reqs.every((r) => r.allowed) &&
    modelUrls.every((url) => reqs.some((r) => r.file === url)))
  return reqs.length
}

async function deleteFromSettings(app, win, expectedRows) {
  const sw = await openSettings(app, win)
  await noteVisibility(app)
  const before = vectorRows()
  check('all sample vectors present before Delete', before.length === expectedRows, before.length)
  await sw.getByRole('button', { name: 'Delete model', exact: true }).click({ timeout: 10000 })
  await sw.locator('.pic-confirm').waitFor({ timeout: 10000 })
  await sw.getByRole('button', { name: 'Delete', exact: true }).click({ timeout: 10000 })
  const gone = await waitFor(win, (s) => s.model === 'absent', 30000, 'model deleted')
  const downloadButton = sw.locator('.pic-settings[data-model="absent"]').getByRole('button', { name: /^Download model \(/ })
  await sw.waitForFunction(() => {
    const button = document.querySelector('.pic-settings[data-model="absent"] .pic-primary')
    return button && !button.disabled
  }, null, { timeout: 10000 })
  check('Settings returns to Download after Delete', await downloadButton.isEnabled() &&
    (await sw.locator('.pic-ready, .pic-confirm, .pic-progress, .pic-error').count()) === 0)
  check('model files gone and indexing idle after Delete', !existsSync(modelDir) && gone.index.phase === 'idle')
  const after = vectorRows()
  check('vectors kept byte for byte after Delete', isDeepStrictEqual(after, before), `${after.length}/${before.length} rows`)
  out('vectors after model deletion', after.length)
}

// ---------- run 1: prepare the model, index and pause ----------
let { app, win } = await launch()
try {
  if (!download) {
    const st0 = await status(win)
    check('cached model is ready', st0.model === 'ready', st0.model)
  }
  const sw = await openSettings(app, win)
  await noteVisibility(app)
  const note = (await sw.locator('.pic-note').textContent())?.trim()
  out('settings note', note)
  check('well images on by default', await sw.locator('.pic-check input').isChecked())
  const downloadRequests = download ? await downloadFromSettings(app, win, sw) : 0
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
  check('no network request during indexing and pause', (await requests(app)).length === downloadRequests)
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
  const queryImage = join(scratch, 'submarine-query.webp')
  await writePictureQueryImage(queryImage)
  copyFileSync(queryImage, join(well, '_inbox', 'new-arrival.webp'))
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
  if (expectId) check('expected slide ranks first for the text query', firstId === expectId, `got ${firstId}, expected ${expectId}`)
  if (wellVec) {
    const sim = await win.evaluate((id) => window.sw.picture.query({ imageId: id }, { limit: 3 }), wellVec.id)
    out('query by well image', sim.results.map((r) => `${r.id} ${r.score.toFixed(3)}`))
    check('more-like-this query by image id', sim.ok && sim.results.length === 3 && !sim.results.some((r) => r.id === wellVec.id))
    check('expected slide ranks first for the image query', sim.results[0]?.id === IMAGE_MATCH_ID,
      `got ${sim.results[0]?.id}, expected ${IMAGE_MATCH_ID}`)
  }

  check('no network request during final queries', (await requests(app)).length === 0)
  if (download) {
    await deleteFromSettings(app, win, expected + 1)
    check('no network request during Delete', (await requests(app)).length === 0)
  }
} finally {
  await app.close()
}
check('no window shown or focused during the run', windowShown === null, JSON.stringify(windowShown))
out('screenshots', screens)
console.log(failed ? 'PICTURE SEARCH E2E: FAILED' : 'PICTURE SEARCH E2E: PASSED')
finish(failed ? 'assertion failed' : null)
