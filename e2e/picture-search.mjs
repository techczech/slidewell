// End-to-end: picture search (ticket 03). Switch on from Settings, index a small sample in the
// background, pause/resume across a restart, resume after a hard kill mid-run, embed a new well
// image as it arrives, query by text and by image, keep word search responsive, delete the model.
//
// Run after `npm run build`:
//   SLIDEWELL_PICTURE_SAMPLE=<a Core A archive folder, e.g. a 50-slide sample> \
//   SLIDEWELL_PICTURE_EXPECT='slide:<presentation id>#<order>' \   (optional: must rank first)
//   node e2e/picture-search.mjs
// Optional: SLIDEWELL_PICTURE_QUERY (default 'robots in a classroom'), SLIDEWELL_PICTURE_SCRATCH
// (default ~/Library/Caches/slidewell-e2e-picture-search), SLIDEWELL_PICTURE_KEEP_MODEL=1 (reuse a model
// already in the scratch profile: skips the download and delete steps).
//
// Isolation: own --user-data-dir, own HOME, own well folder, all under the scratch folder. The
// sample archive is only read. The first run downloads the real model (~910 MB) into the scratch
// profile; nothing is written anywhere else.
import { _electron as electron } from 'playwright'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const sample = process.env.SLIDEWELL_PICTURE_SAMPLE
if (!sample || !existsSync(join(sample, 'extracted'))) {
  console.error('Set SLIDEWELL_PICTURE_SAMPLE to an archive folder that has extracted/<id>/renders/.')
  process.exit(2)
}
const expectId = process.env.SLIDEWELL_PICTURE_EXPECT || null
const queryText = process.env.SLIDEWELL_PICTURE_QUERY || 'robots in a classroom'
const keepModel = process.env.SLIDEWELL_PICTURE_KEEP_MODEL === '1'
const scratch = process.env.SLIDEWELL_PICTURE_SCRATCH || join(homedir(), 'Library', 'Caches', 'slidewell-e2e-picture-search')
const userData = join(scratch, 'userData')
const home = join(scratch, 'home')
const well = join(scratch, 'well')
const screens = join(scratch, 'screens')
const modelDir = join(userData, 'models', 'embeddinggemma-2-onnx-fp16')
const storeFile = join(well, 'picture-search.db')

// fresh profile and store every run (the model folder survives only with KEEP_MODEL)
rmSync(well, { recursive: true, force: true })
rmSync(home, { recursive: true, force: true })
rmSync(join(userData, 'config.json'), { force: true })
if (!keepModel) rmSync(join(userData, 'models'), { recursive: true, force: true })
for (const d of [userData, home, well, screens]) mkdirSync(d, { recursive: true })
writeFileSync(join(userData, 'config.json'), JSON.stringify({ archiveRoot: sample, wellRoot: well, othersArchiveRoot: join(scratch, 'others') }), 'utf8')

const results = {}
const out = (k, v) => {
  results[k] = v
  console.log(`${k}: ${JSON.stringify(v)}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const FILTERS = { owner: 'all', era: 'all', category: '', deck: '', role: 'content', cluster: true, from: 'all', kind: 'all', type: 'slides', library: 'mine' }

async function launch() {
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env: { ...process.env, HOME: home } })
  // Record every http(s) request the app makes from here on (net.fetch goes through this session).
  await app.evaluate(({ session }) => {
    globalThis.__requests = []
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (d, cb) => {
      globalThis.__requests.push(d.url)
      cb({})
    })
  })
  // the main window, not the hidden picture-search window (swembed://), which may open first
  let win = null
  for (let i = 0; i < 300 && !win; i++) {
    win = app.windows().find((w) => !w.url().startsWith('swembed:') && w.url() !== 'about:blank') ?? null
    if (!win) await sleep(100)
  }
  if (!win) throw new Error('main window did not open')
  await win.waitForLoadState('domcontentloaded')
  return { app, win }
}
const status = (win) => win.evaluate(() => window.sw.picture.status())
const requests = (app) => app.evaluate(() => globalThis.__requests)
async function waitFor(win, pred, timeoutMs, label) {
  const t0 = Date.now()
  for (;;) {
    const st = await status(win)
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
    const t = await win.evaluate(async (f) => {
      const t0 = performance.now()
      await window.sw.archive.search(['classroom', 'robot', 'reading', 'chart', 'beach'][Math.floor(Math.random() * 5)], f)
      return performance.now() - t0
    }, FILTERS)
    times.push(Math.round(t))
  }
  return times.sort((a, b) => a - b)[Math.floor(n / 2)]
}

let failed = false
const check = (name, ok, detail) => {
  out(`check ${name}`, ok ? 'pass' : `FAIL ${detail ?? ''}`)
  if (!ok) failed = true
}

// ---------- run 1: switch on from Settings ----------
let { app, win } = await launch()
try {
  await sleep(3000)
  const st0 = await status(win)
  if (!keepModel) {
    check('no model before Download', st0.model === 'absent' && !existsSync(modelDir), st0.model)
    check('no network call before Download', (await requests(app)).length === 0, JSON.stringify(await requests(app)))
  }
  await win.locator('button[title^="Settings"]').click()
  await win.locator('.pic-settings h3').waitFor()
  await sleep(800) // estimate
  const note = (await win.locator('.pic-note').textContent())?.trim()
  out('settings note', note)
  check('well images on by default', await win.locator('.pic-check input').isChecked())
  if (!keepModel) {
    const label = (await win.locator('.pic-primary').textContent())?.trim()
    out('download button', label)
    check('download button', /^Download model \(\d+ MB\)$/.test(label ?? ''), label)
    await win.screenshot({ path: join(screens, 'S2-settings-before-download.png') })
    const t0 = Date.now()
    await win.locator('.pic-primary').click()
    await waitFor(win, (s) => s.model === 'downloading' && s.download?.receivedBytes > 50e6, 120000, 'download progress')
    await win.screenshot({ path: join(screens, 'S2-settings-downloading.png') })
    const reqs = await requests(app)
    // Requests: the pinned revision's resolve URLs, plus Hugging Face's own redirects/CDN (same family of hosts).
    const hfHost = (u) => /(^|\.)(huggingface\.co|hf\.co)$/.test(new URL(u).hostname)
    const pinned = reqs.filter((u) => /^https:\/\/huggingface\.co\/onnx-community\/embeddinggemma-2-ONNX\/resolve\/[0-9a-f]{40}\//.test(u))
    out('download hosts', [...new Set(reqs.map((u) => new URL(u).hostname))])
    check('download goes only to Hugging Face, at the pinned revision', reqs.length > 0 && reqs.every(hfHost) && pinned.length >= 3, JSON.stringify(reqs.filter((u) => !hfHost(u)).slice(0, 3)))
    await waitFor(win, (s) => s.model === 'ready', 60 * 60 * 1000, 'model ready')
    out('download seconds', Math.round((Date.now() - t0) / 1000))
    check('model verified on disk', existsSync(join(modelDir, 'verified.json')))
  } else {
    check('kept model is ready', st0.model === 'ready', st0.model)
  }
  // indexing starts by itself; pause from the status bar once a few are done
  await waitFor(win, (s) => s.index.phase === 'indexing' && s.index.done >= 5, 120000, 'indexing under way')
  await win.locator('button.copyref', { hasText: 'close' }).click()
  out('status bar while indexing', await statusBar(win))
  results.busyMs = await wordSearchMs(win)
  out('word search ms during indexing (median of 5)', results.busyMs)
  await win.screenshot({ path: join(screens, 'S3-status-indexing.png') })
  await win.locator('.statusbar .pic-btn', { hasText: 'Pause' }).click()
  const paused = await waitFor(win, (s) => s.index.phase === 'paused', 15000, 'paused')
  out('paused at', `${paused.index.done} / ${paused.index.total}`)
  check('pause stops mid-run', paused.index.done > 0 && paused.index.done < paused.index.total)
  await win.screenshot({ path: join(screens, 'S3-status-paused.png') })
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
  check('all sample images indexed', done.index.done === done.index.total && rows.length + done.index.failed === done.index.total)
  check('nothing embedded twice across restarts', reembedded === 0, `${reembedded} re-embedded`)
  const idleMs = await wordSearchMs(win)
  out('word search ms idle (median of 5)', idleMs)
  // word search must stay responsive while indexing: under 250 ms and within 10× the idle time
  check('word search responsive during indexing', results.busyMs <= 250 && results.busyMs <= 10 * Math.max(1, idleMs), `${results.busyMs} ms busy vs ${idleMs} ms idle`)

  // a new well image arrives (dropped into the well inbox) → embedded without a restart
  const someRender = (() => {
    for (const d of readdirSync(join(sample, 'extracted'))) {
      const r = join(sample, 'extracted', d, 'renders')
      if (existsSync(r)) {
        const f = readdirSync(r).find((x) => x.endsWith('.webp'))
        if (f) return join(r, f)
      }
    }
  })()
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
  if (expectId) check('expected slide ranks first', q.ok && q.results[0]?.id === expectId, q.results[0]?.id)
  const sim = await win.evaluate((id) => window.sw.picture.query({ imageId: id }, { limit: 3 }), q.results[0].id)
  check('more-like-this query by image id', sim.ok && sim.results.length === 3 && !sim.results.some((r) => r.id === q.results[0].id))

  if (!keepModel) {
    await win.locator('button[title^="Settings"]').click()
    await win.locator('.pic-settings h3').waitFor()
    await win.screenshot({ path: join(screens, 'S2-settings-ready.png') })
    await win.locator('.pic-settings button', { hasText: 'Delete model' }).click()
    await win.locator('.pic-settings button.pic-danger').click()
    const gone = await waitFor(win, (s) => s.model === 'absent', 30000, 'model deleted')
    check('delete model from Settings', gone.model === 'absent' && !existsSync(modelDir))
    check('vectors kept after delete', vectorRows().length === rows.length + 1)
    await win.screenshot({ path: join(screens, 'S2-settings-after-delete.png') })
  }
} finally {
  await app.close()
}
out('screenshots', screens)
console.log(failed ? 'PICTURE SEARCH E2E: FAILED' : 'PICTURE SEARCH E2E: PASSED')
process.exit(failed ? 1 : 0)
