// Hidden end-to-end: train on generated captures, then sort undecided captures offline.
// Run npm run test:sorter with SLIDEWELL_SORTER_MODEL_DIR (or SLIDEWELL_PICTURE_MODEL_DIR)
// pointing to a verified local EmbeddingGemma 2 cache. Optional SLIDEWELL_SORTER_LIMIT (default: all).
import { finish, recordFailure } from './support/result.mjs'
import { createScratch, launchHidden } from './support/scratch.mjs'
import { copyCachedPictureModel, requireCachedPictureModel } from './support/cached-picture-model.mjs'
import { makeSorterFixture } from './support/sorter-fixture.mjs'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const model = requireCachedPictureModel('SLIDEWELL_SORTER_MODEL_DIR', 'SLIDEWELL_PICTURE_MODEL_DIR')
const scratch = createScratch('sorter')
const limitEnv = process.env.SLIDEWELL_SORTER_LIMIT ?? 'all'
const limit = limitEnv === 'all' ? undefined : Number(limitEnv)
if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
  finish('SLIDEWELL_SORTER_LIMIT must be a positive integer or all.', 2)
}
const userData = join(scratch, 'userData')
const home = join(scratch, 'home')
const screens = join(scratch, 'screens')
const { well, undecided, originalsUnchanged } = await makeSorterFixture(scratch)
mkdirSync(screens)
copyCachedPictureModel(model, userData)
writeFileSync(join(userData, 'config.json'), JSON.stringify({
  archiveRoot: join(scratch, 'no-archive'),
  wellRoot: well,
  othersArchiveRoot: join(scratch, 'no-others'),
  vaultRoot: join(scratch, 'no-vault'),
  ownerNames: ['Aster Quill'],
  pictureSearch: { paused: true, includeWell: false }
}))

const results = {}
const out = (k, v) => {
  results[k] = v
  console.log(`${k}: ${JSON.stringify(v)}`)
}
const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) {
    recordFailure(name)
    fails.push(name)
  }
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

const app = await launchHidden(userData, home, { isolatePreferences: true })
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
  check('fixture starts without a trained report', !st0.report)
  if (!st0.report) {
    const refused = await win.evaluate(() => window.sw.sorter.sort({ limit: 1 }))
    check('sorting refused before a held-back report exists', !refused.ok && /train/.test(refused.error ?? ''), refused.error)
  }

  const t0 = Date.now()
  // The sorter status IPC measures the main process reply while the worker trains. The Node
  // inspector can reject an evaluation while this window and the training job are still live.
  const trainingDocument = await win.evaluate(() => {
    window.__trainingRoot = document.querySelector('.app')
    if (!window.__trainingRoot) throw new Error('SlideWell app root is missing')
    window.__train = window.sw.sorter.train().then((r) => (window.__trained = r))
    return performance.timeOrigin
  })
  let trained = null
  // samples per training step (grouping, then fitting): polled back to back so short steps are caught
  const steps = {}
  while (!trained) {
    const a = Date.now()
    const st = await win.evaluate(async () => {
      const { phase, message } = await window.sw.sorter.status()
      return {
        phase,
        message,
        document: performance.timeOrigin,
        sameRoot: document.querySelector('.app') === window.__trainingRoot,
        trained: window.__trained ?? null
      }
    })
    const ms = Date.now() - a
    if (st.document !== trainingDocument || !st.sameRoot) throw new Error('SlideWell replaced its view during sorter training')
    if (st.phase === 'training') {
      const k = /grouping/.test(st.message) ? 'grouping' : 'fitting'
      steps[k] = { samples: (steps[k]?.samples ?? 0) + 1, slowestReplyMs: Math.max(steps[k]?.slowestReplyMs ?? 0, ms) }
    }
    trained = st.trained
  }
  out('train seconds', Math.round((Date.now() - t0) / 1000))
  out('main process during training', steps)
  for (const k of ['grouping', 'fitting'])
    check(`main process stays responsive while ${k} (slowest reply < 500 ms)`, (steps[k]?.samples ?? 0) > 0 && steps[k].slowestReplyMs < 500, JSON.stringify(steps[k] ?? null))
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
  // sorting (rules, classifier and the copy-of-kept scan in the worker): the main process must keep answering
  await win.evaluate((lim) => {
    window.__sortRun = window.sw.sorter.sort(lim === null ? {} : { limit: lim }).then((r) => (window.__sorted = r))
  }, limit ?? null)
  const sortSteps = { samples: 0, slowestReplyMs: 0 }
  while (!(await win.evaluate(() => window.__sorted ?? null))) {
    const a = Date.now()
    const st = await win.evaluate(() => window.sw.sorter.status().then((s) => s.phase))
    const ms = Date.now() - a
    if (st === 'sorting' || st === 'embedding') {
      sortSteps.samples++
      sortSteps.slowestReplyMs = Math.max(sortSteps.slowestReplyMs, ms)
    }
  }
  const sorted = await win.evaluate(() => window.__sorted)
  out('main process during sorting', sortSteps)
  check('main process stays responsive while sorting (slowest reply < 500 ms)', sortSteps.samples > 0 && sortSteps.slowestReplyMs < 500, JSON.stringify(sortSteps))
  out('sort seconds', Math.round((Date.now() - t1) / 1000))
  out('sort', sorted)
  check('sorting finished', sorted.ok, sorted.error)

  // The accuracy report is no longer in Settings (the Settings window holds only the service, keys and agreements);
  // it is on Triage > Auto sorting, behind "Accuracy table and thresholds: show".
  await win.locator('.view-switch .scope-tab', { hasText: 'Triage' }).click()
  await win.locator('.triage-controls .scope-tab', { hasText: 'Auto sorting' }).click()
  await win.locator('.as-accuracy-toggle').click()
  await win.locator('.sorter-report .sorter-table').waitFor({ timeout: 10000 })
  const shown = await win.locator('.sorter-report').innerText()
  check('Auto sorting shows the accuracy report', /Keep right/.test(shown) && /Throwaway right/.test(shown) && /Need a look/.test(shown))
  await win.locator('.sorter-report').scrollIntoViewIfNeeded()
  await win.locator('.sorter-report').screenshot({ path: join(screens, 'settings-sorter.png') })

  const reqs = await app.evaluate(() => globalThis.__requests)
  check('no network request', reqs.length === 0, JSON.stringify(reqs.slice(0, 5)))
} finally {
  await app.close().catch(() => undefined)
}

// after the app has closed: decisions untouched, proposals only for undecided screenshots
check('seeded triage decisions are unchanged', JSON.stringify(readDb('SELECT hash, state, decided_at, well_id FROM triage_decisions ORDER BY hash')) === decisionsBefore)
const overlap = readDb('SELECT COUNT(*) AS n FROM sorter_proposals p JOIN triage_decisions d ON d.hash = p.hash')[0].n
check('no proposal for a screenshot he already decided', overlap === 0, `${overlap}`)
const byLabel = readDb('SELECT proposal, COUNT(*) AS n, ROUND(MIN(confidence), 3) AS min_conf FROM sorter_proposals GROUP BY proposal')
out('proposals stored', byLabel)
check('each requested undecided capture has a stored proposal', byLabel.reduce((n, row) => n + row.n, 0) === Math.min(limit ?? undecided, undecided))
check('generated source files are unchanged', originalsUnchanged())
const rep = results.report
if (rep) {
  const low = readDb(`SELECT COUNT(*) AS n FROM sorter_proposals WHERE proposal = 'throwaway' AND confidence < ${rep.thresholds.throwaway}`)[0].n
  check('no stored throwaway below the throwaway threshold', low === 0, `${low}`)
}
out('sample reasons', readDb("SELECT proposal, ROUND(confidence, 2) AS confidence, reason FROM sorter_proposals GROUP BY proposal, reason ORDER BY proposal LIMIT 20"))
writeFileSync(join(scratch, 'sorter-e2e-results.json'), JSON.stringify(results, null, 2))
console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join('; ')}` : '\nALL PASSED')
finish(fails.length ? 'assertion failed' : null)
