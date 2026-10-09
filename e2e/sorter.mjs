// End-to-end: screenshot sorter, local part (ticket 06), on a COPY of a real well.
// Trains on the labelled history (well screenshots + triage included = keep, triage excluded =
// throwaway), writes the held-back accuracy report, sorts undecided screenshots, and checks that
// his decisions and his files are untouched and that no network request was made (every http(s)
// request is cancelled, so the run also proves the sorter works offline).
//
// Run after `npm run build` (or `npx electron-vite build`):
//   SLIDEWELL_SORTER_SOURCE_WELL=<a well folder: triage.db, well.db, images/>   (read only)
//   SLIDEWELL_SORTER_MODEL_DIR=<an existing embeddinggemma-2-onnx-fp16 folder>  (read only; cloned)
//   node e2e/sorter.mjs
// Optional: SLIDEWELL_SORTER_SCRATCH (default ~/Library/Caches/slidewell-e2e-sorter),
//   SLIDEWELL_SORTER_LIMIT (undecided screenshots to sort; default 200; 'all' for every one),
//   SLIDEWELL_SORTER_RECOPY=0 (keep the scratch databases from the last run).
//
// Isolation: own --user-data-dir, own HOME, own well folder under the scratch folder. The source
// well's databases are copied with sqlite3 .backup on a read-only connection; its images are cloned.
// Triage screenshots are read in place (their source folder is only read). Picture vectors are kept
// in the scratch well between runs as a cache.
import { _electron as electron } from 'playwright'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const sourceWell = process.env.SLIDEWELL_SORTER_SOURCE_WELL
const modelSrc = process.env.SLIDEWELL_SORTER_MODEL_DIR
if (!sourceWell || !existsSync(join(sourceWell, 'triage.db'))) {
  console.error('Set SLIDEWELL_SORTER_SOURCE_WELL to a well folder with triage.db.')
  process.exit(2)
}
const scratch = process.env.SLIDEWELL_SORTER_SCRATCH || join(homedir(), 'Library', 'Caches', 'slidewell-e2e-sorter')
const limitEnv = process.env.SLIDEWELL_SORTER_LIMIT || '200'
const limit = limitEnv === 'all' ? undefined : Number(limitEnv)
const recopy = process.env.SLIDEWELL_SORTER_RECOPY !== '0'
const userData = join(scratch, 'userData')
const home = join(scratch, 'home')
const well = join(scratch, 'well')
const screens = join(scratch, 'screens')
const modelDir = join(userData, 'models', 'embeddinggemma-2-onnx-fp16')

for (const d of [userData, home, well, screens, join(userData, 'models')]) mkdirSync(d, { recursive: true })
if (!existsSync(join(modelDir, 'verified.json'))) {
  if (!modelSrc || !existsSync(join(modelSrc, 'verified.json'))) {
    console.error('Set SLIDEWELL_SORTER_MODEL_DIR to a verified embeddinggemma-2-onnx-fp16 folder (nothing is downloaded).')
    process.exit(2)
  }
  execFileSync('cp', ['-cR', modelSrc, join(userData, 'models')]) // APFS clone, no extra space
}
if (recopy) {
  for (const f of ['triage.db', 'well.db']) {
    rmSync(join(well, f), { force: true })
    if (existsSync(join(sourceWell, f))) execFileSync('/usr/bin/sqlite3', [`file:${join(sourceWell, f)}?mode=ro`, `.backup '${join(well, f).replace(/'/g, "''")}'`])
  }
  rmSync(join(well, 'images'), { recursive: true, force: true })
  if (existsSync(join(sourceWell, 'images'))) execFileSync('cp', ['-cR', join(sourceWell, 'images'), well])
}
// no archive, no triage sources, no vault: the app only has the copied well; background indexing paused
writeFileSync(
  join(userData, 'config.json'),
  JSON.stringify({ archiveRoot: join(scratch, 'no-archive'), wellRoot: well, othersArchiveRoot: join(scratch, 'others'), vaultRoot: join(scratch, 'no-vault'), pictureSearch: { paused: true, includeWell: false } }),
  'utf8'
)

const results = {}
const out = (k, v) => {
  results[k] = v
  console.log(`${k}: ${JSON.stringify(v)}`)
}
const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fails.push(name)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readDb = (sql) => {
  const db = new DatabaseSync(join(well, 'triage.db'), { readOnly: true })
  try {
    return db.prepare(sql).all()
  } finally {
    db.close()
  }
}

const decisionsBefore = JSON.stringify(readDb('SELECT hash, state, decided_at, well_id FROM triage_decisions ORDER BY hash'))

const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env: { ...process.env, HOME: home, SLIDEWELL_E2E_HIDDEN: '1' } })
try {
  // offline: record and CANCEL every http(s) request from here on
  await app.evaluate(({ session }) => {
    globalThis.__requests = []
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (d, cb) => {
      globalThis.__requests.push(d.url)
      cb({ cancel: true })
    })
  })
  let win = null
  for (let i = 0; i < 300 && !win; i++) {
    win = app.windows().find((w) => !w.url().startsWith('swembed:') && w.url() !== 'about:blank') ?? null
    if (!win) await sleep(100)
  }
  if (!win) throw new Error('main window did not open')
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => Boolean(window.sw?.sorter))

  const st0 = await win.evaluate(() => window.sw.sorter.status())
  check('picture model ready (cloned, not downloaded)', st0.modelReady)
  if (!st0.report) {
    const refused = await win.evaluate(() => window.sw.sorter.sort({ limit: 1 }))
    check('sorting refused before a held-back report exists', !refused.ok && /train/.test(refused.error ?? ''), refused.error)
  } else console.log('SKIP sorting-refused check: the scratch copy already has a report (SLIDEWELL_SORTER_RECOPY=0)')

  const t0 = Date.now()
  // start training, then keep asking the main process for a reply: training runs in a worker thread,
  // so the main process should answer quickly throughout (the fit itself is CPU-bound for seconds)
  await win.evaluate(() => {
    window.__train = window.sw.sorter.train().then((r) => (window.__trained = r))
  })
  let trained = null
  let maxMainMs = 0
  let trainingSamples = 0
  while (!trained) {
    const a = Date.now()
    const phase = await app.evaluate(() => 'ok').then(() => win.evaluate(() => window.sw.sorter.status().then((s) => s.phase)))
    const ms = Date.now() - a
    if (phase === 'training') {
      trainingSamples++
      maxMainMs = Math.max(maxMainMs, ms)
    }
    trained = await win.evaluate(() => window.__trained ?? null)
    if (!trained) await sleep(50)
  }
  out('train seconds', Math.round((Date.now() - t0) / 1000))
  out('main process during training', { samples: trainingSamples, slowestReplyMs: maxMainMs })
  check('main process stays responsive while training (slowest reply < 500 ms)', trainingSamples > 0 && maxMainMs < 500, `${trainingSamples} samples, slowest ${maxMainMs} ms`)
  check('training finished', trained.ok, trained.error)
  const rep = trained.report
  out('report', rep)
  if (rep) {
    const a = rep.heldBack
    const sum = a.keep.proposed + a.throwaway.proposed + a.doubtful.count
    const target = (n) => Math.ceil(n * 0.2)
    check(
      'held-back sample: whole groups, at most 20% of each label, and at least 80% of that',
      a.truth.keep <= target(rep.usable.keep) && a.truth.throwaway <= target(rep.usable.throwaway) && a.truth.keep >= 0.8 * target(rep.usable.keep) && a.truth.throwaway >= 0.8 * target(rep.usable.throwaway),
      JSON.stringify({ truth: a.truth, usable: rep.usable, grouping: rep.grouping })
    )
    check('enough held-back evidence to sort unattended', rep.enoughToMeasure === true)
    check('every held-back screenshot got a proposal', sum === a.sample)
    check('calibration chosen inside the training split and reported', Boolean(rep.calibration?.chosen) && rep.heldBackClassifier?.auc !== undefined, JSON.stringify(rep.calibration?.brier))
    const tp = a.throwaway.precision
    console.log(tp === null ? 'NOTE throwaway precision at the threshold: nothing proposed' : tp < 0.95 ? `NOTE throwaway precision ${tp.toFixed(3)} is BELOW 0.95` : `NOTE throwaway precision ${tp.toFixed(3)} meets 0.95`)
  }

  // Stop during training: the worker is terminated, the run returns cancelled, nothing is saved
  const modelsBefore = readDb('SELECT COUNT(*) AS n FROM sorter_models')[0].n
  await win.evaluate(() => {
    window.__stopRun = window.sw.sorter.train().then((r) => (window.__stopped = r))
  })
  for (let i = 0; i < 600; i++) {
    if ((await win.evaluate(() => window.sw.sorter.status().then((s) => s.phase))) === 'training') break
    await sleep(20)
  }
  await win.evaluate(() => window.sw.sorter.cancel())
  const stopped = await win.evaluate(() => window.__stopRun.then(() => window.__stopped))
  check('Stop during training returns cancelled and saves nothing', stopped.cancelled === true && readDb('SELECT COUNT(*) AS n FROM sorter_models')[0].n === modelsBefore, JSON.stringify(stopped))

  const t1 = Date.now()
  const sorted = await win.evaluate((lim) => window.sw.sorter.sort(lim === null ? {} : { limit: lim }), limit ?? null)
  out('sort seconds', Math.round((Date.now() - t1) / 1000))
  out('sort', sorted)
  check('sorting finished', sorted.ok, sorted.error)

  // Settings shows the report
  await win.locator('button[title^="Settings"]').click()
  await win.locator('.sorter-settings .sorter-table').waitFor({ timeout: 10000 })
  const shown = await win.locator('.sorter-settings').innerText()
  check('Settings shows the accuracy report', /Keep right/.test(shown) && /Throwaway right/.test(shown) && /Need a look/.test(shown))
  await win.locator('.sorter-settings').scrollIntoViewIfNeeded()
  await win.locator('.sorter-settings').screenshot({ path: join(screens, 'settings-sorter.png') })

  const reqs = await app.evaluate(() => globalThis.__requests)
  check('no network request', reqs.length === 0, JSON.stringify(reqs.slice(0, 5)))
} finally {
  await app.close().catch(() => undefined)
}

// after the app has closed: decisions untouched, proposals only for undecided screenshots
check('his triage decisions are unchanged', JSON.stringify(readDb('SELECT hash, state, decided_at, well_id FROM triage_decisions ORDER BY hash')) === decisionsBefore)
const overlap = readDb('SELECT COUNT(*) AS n FROM sorter_proposals p JOIN triage_decisions d ON d.hash = p.hash')[0].n
check('no proposal for a screenshot he already decided', overlap === 0, `${overlap}`)
const byLabel = readDb('SELECT proposal, COUNT(*) AS n, ROUND(MIN(confidence), 3) AS min_conf FROM sorter_proposals GROUP BY proposal')
out('proposals stored', byLabel)
const rep = results.report
if (rep) {
  const low = readDb(`SELECT COUNT(*) AS n FROM sorter_proposals WHERE proposal = 'throwaway' AND confidence < ${rep.thresholds.throwaway}`)[0].n
  check('no stored throwaway below the throwaway threshold', low === 0, `${low}`)
}
out('sample reasons', readDb("SELECT proposal, ROUND(confidence, 2) AS confidence, reason FROM sorter_proposals GROUP BY proposal, reason ORDER BY proposal LIMIT 20"))
writeFileSync(join(scratch, 'sorter-e2e-results.json'), JSON.stringify(results, null, 2))
console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join('; ')}` : '\nALL PASSED')
process.exit(fails.length ? 1 : 0)
