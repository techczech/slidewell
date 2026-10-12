// Triage as a main tab, the Auto sorting tab and the shortened Settings › Screenshot sorter, through the
// renderer mock (no Electron, no real data). The renderer runs under plain Vite in chrome-headless-shell;
// window.sw.sorter, .cloud and .triage.list are replaced by a stateful fake with invented numbers, so the
// tab can be shown trained, never trained and during a sort, and every command it sends can be counted.
//
// Run: node e2e/auto-sorting-ui.mjs      Screenshots: only when SLIDEWELL_AUTOSORT_SCREENS names a folder
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..', 'src', 'renderer')
const screens = process.env.SLIDEWELL_AUTOSORT_SCREENS ? resolve(process.env.SLIDEWELL_AUTOSORT_SCREENS) : null
if (screens) mkdirSync(screens, { recursive: true })
const shoot = (page, name) => (screens ? page.screenshot({ path: join(screens, name) }) : Promise.resolve())
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) failed++
}

// The fake, installed before the app's own mock so that every hook (title bar, tab, Settings) sees it.
function installFake() {
  const today = (h, m) => {
    const d = new Date()
    d.setHours(h, m, 0, 0)
    return d.toISOString()
  }
  const PERIODS = [
    { id: '7d', label: 'Last 7 days' },
    { id: '30d', label: 'Last 30 days' },
    { id: '90d', label: 'Last 90 days' },
    { id: 'all', label: 'Everything' }
  ]
  const providers = [
    { id: 'openai', name: 'Luna', company: 'OpenAI', model: 'gpt-6-luna', hasKey: false, agreedAt: null },
    { id: 'anthropic', name: 'Haiku', company: 'Anthropic', model: 'claude-haiku-5-5', hasKey: true, agreedAt: '2026-10-03T21:14:00' }
  ]
  const report = {
    trainedAt: today(2, 0), sorterVersion: 'x', thresholds: { throwaway: 0.9, keep: 0.8 }, holdOutFraction: 0.2, labelled: { keep: 228, throwaway: 84 }, usable: { keep: 228, throwaway: 84 }, keepFromWellCopy: 0,
    grouping: { groups: 1, largest: 1, cosine: 0.9, minutes: 1 }, enoughToMeasure: true, trainedOn: { keep: 228, throwaway: 84 }, l2: 1,
    calibration: { chosen: 'platt', brier: { raw: 0.1, platt: 0.08, isotonic: 0.09 }, reliability: { platt: [], isotonic: [] } }, heldBackClassifier: { auc: 0.9, brier: 0.08, reliability: [] },
    heldBack: { sample: 60, truth: { keep: 44, throwaway: 16 }, keep: { proposed: 40, correct: 38, precision: 0.95 }, throwaway: { proposed: 11, correct: 10, precision: 0.91 }, doubtful: { count: 9, share: 0.15 }, keptProposedThrowaway: 1, binnedProposedKeep: 2 },
    rulesOnly: { sample: 60, truth: { keep: 44, throwaway: 16 }, keep: { proposed: 30, correct: 24, precision: 0.8 }, throwaway: { proposed: 5, correct: 4, precision: 0.8 }, doubtful: { count: 25, share: 0.42 }, keptProposedThrowaway: 1, binnedProposedKeep: 1 }
  }
  const sorter = {
    phase: 'idle', done: 0, total: 0, message: '', error: null, modelReady: true, report, canRunUnattended: true, retrainNeeded: false, minHeldBack: { total: 20, perLabel: 5 },
    pending: { keep: 331, throwaway: 240, doubtful: 41, lastProposedAt: today(2, 0) }, period: '30d', periods: PERIODS,
    lastRun: { at: today(2, 0), period: 'all', lookedAt: 612, confident: 554, needLook: 58 }, undecided: { period: '30d', inPeriod: 630, all: 1482 }, learnable: { kept: 228, binned: 84 }
  }
  const cloud = {
    phase: 'idle', done: 0, total: 0, hasKey: true, encryptionAvailable: true,
    settings: { enabled: true, batchTime: '02:00', provider: 'anthropic', nightly: true, secondOpinions: true, agreedAt: { openai: null, anthropic: '2026-10-03T21:14:00' } },
    nightlyLimit: 300, leftTonight: 300, nextRunAt: new Date(Date.now() + 86400000).toISOString(), model: 'claude-haiku-5-5', name: 'Haiku', company: 'Anthropic', longEdge: 1456, providers, period: '30d', periods: PERIODS,
    lastRun: { at: today(2, 1), trigger: 'nightly', provider: 'anthropic', local: null, asked: 58, answered: 58, keep: 10, throwaway: 7, stayedDoubtful: 41, sent: 58, settled: 17, stillUnsure: 41, skipped: null, error: null, message: 'Asked Haiku about 58 screenshots.' }
  }
  const calls = { sort: 0, train: 0, prepare: 0, send: [], cancel: 0, cloudCancel: 0, decide: 0, setSettings: [], setNightly: [], setSecond: [] }
  const subs = { sorter: new Set(), cloud: new Set() }
  const snap = () => ({ ...cloud, settings: { ...cloud.settings }, providers: providers.map((p) => ({ ...p })) })
  const push = () => {
    subs.sorter.forEach((f) => f({ ...sorter }))
    subs.cloud.forEach((f) => f(snap()))
  }
  const sync = () => {
    const p = providers.find((x) => x.id === cloud.settings.provider)
    Object.assign(cloud, { hasKey: p.hasKey, model: p.model, name: p.name, company: p.company })
    cloud.settings.enabled = cloud.settings.enabled && Boolean(cloud.settings.agreedAt[cloud.settings.provider])
    return snap()
  }
  window.__fake = {
    sorter, cloud, calls, push,
    install(sw) {
      sw.sorter = {
        status: async () => ({ ...sorter }),
        train: async () => { calls.train++; return { ok: true } },
        sort: async () => { calls.sort++; return { ok: true, sorted: 630, counts: { keep: 300, throwaway: 250, doubtful: 80 }, periodPhrase: ' from the last 30 days' } },
        setPeriod: async (p) => { sorter.period = p; cloud.period = p; sorter.undecided = { period: p, inPeriod: p === 'all' ? null : 100, all: 1482 }; push(); return { ok: true, period: p } },
        cancel: async () => { calls.cancel++ },
        onStatus: (cb) => { subs.sorter.add(cb); return () => subs.sorter.delete(cb) }
      }
      sw.cloud = {
        status: async () => sync(),
        setKey: async (provider, k) => { const p = providers.find((x) => x.id === provider); p.hasKey = true; return { ok: true, saved: true, status: sync() } },
        clearKey: async (provider) => { providers.find((x) => x.id === provider).hasKey = false; return sync() },
        setSettings: async (patch) => {
          calls.setSettings.push(patch)
          if (patch.provider) cloud.settings.provider = patch.provider
          if (patch.enabled === true) { cloud.settings.agreedAt[cloud.settings.provider] ??= new Date().toISOString(); providers.find((x) => x.id === cloud.settings.provider).agreedAt = cloud.settings.agreedAt[cloud.settings.provider] }
          if (patch.enabled !== undefined) cloud.settings.enabled = patch.enabled
          if (patch.batchTime) cloud.settings.batchTime = patch.batchTime
          return sync()
        },
        setNightly: async (on) => { calls.setNightly.push(on); cloud.settings.nightly = on; return { ok: true, status: sync() } },
        setSecondOpinions: async (on) => { calls.setSecond.push(on); cloud.settings.secondOpinions = on; return { ok: true, status: sync() } },
        prepare: async () => { calls.prepare++; return { local: { ok: true, message: 'Sorted 630 from the last 30 days: 300 keep, 250 throwaway, 80 need a look.' }, provider: 'anthropic', period: '30d', periodLabel: 'Last 30 days', periodPrefix: 'Last 30 days: ', periodNote: 'Only screenshots with a date in the file name are counted.', doubtful: 80, toSend: 58, secondOpinions: 0, secondNote: '', cap: 300, leftTonight: 300, estimate: { screenshots: 58, requests: 3, inputTokens: 1, outputTokens: 1, usd: 0.12 }, costLabel: 'Estimated cost', costNote: '', blocked: null, token: 'tok-1', message: 'Last 30 days: ask Haiku about 58 screenshots?' } },
        send: async (token) => { calls.send.push(token); return { at: new Date().toISOString(), trigger: 'manual', local: null, asked: 58, answered: 58, keep: 10, throwaway: 7, stayedDoubtful: 41, sent: 58, settled: 17, stillUnsure: 41, skipped: null, error: null, message: 'Asked Haiku about 58 screenshots: 10 keep, 7 throwaway.' } },
        cancel: async () => { calls.cloudCancel++ },
        onStatus: (cb) => { subs.cloud.add(cb); return () => subs.cloud.delete(cb) }
      }
      const list = sw.triage.list
      sw.triage.list = async (...a) => ({ ...(await list(...a)), counts: { undecided: 1482, selected: 96, included: 0, excluded: 2310, total: 3888 } })
      const decide = sw.triage.decide
      sw.triage.decide = async (...a) => { calls.decide++; return decide(...a) }
    }
  }
}

const server = await createServer({ configFile: false, root, plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const url = server.resolvedUrls.local[0]
const browser = await chromium.launch({ headless: true }) // Playwright's chrome-headless-shell, never an installed Chrome
console.log(`browser: ${browser.version()} (headless shell)`)
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.addInitScript(installFake)
  await page.addInitScript(() => {
    let real
    Object.defineProperty(window, 'sw', { configurable: true, get: () => real, set: (v) => { real = v; window.__fake.install(v) } })
  })
  await page.goto(url)
  await page.waitForSelector('.view-switch')
  const fake = (fn, arg) => page.evaluate(fn, arg)
  const tabs = () => page.locator('.view-switch .scope-tab').allInnerTexts()
  const text = (sel) => page.locator(sel).first().innerText()

  // --- Triage is a main tab ---
  const labels = (await tabs()).map((t) => t.replace(/\s+/g, ' ').trim())
  check('title bar: Search | Review | Triage', labels[0] === 'Search' && labels[1].startsWith('Review') && labels[2] === 'Triage', labels.join(' | '))
  await page.locator('.view-switch .scope-tab', { hasText: 'Triage' }).click()
  await page.waitForSelector('.triage-panel')
  check('Triage fills the window: no overlay, no close button', (await page.locator('.triage-panel').count()) === 1 && (await page.locator('.triage-overlay, .overlay').count()) === 0 && (await page.getByText('close ✕').count()) === 0)
  const box = await page.locator('.triage-panel').boundingBox()
  check('the panel spans the full width under the title bar', box.x === 0 && box.width === 1440 && box.y > 30, JSON.stringify(box))
  const gridTabs = (await page.locator('.triage-controls .scope-tab').allInnerTexts()).map((t) => t.trim())
  check('tabs: Undecided, Selected, Excluded, All, Auto sorting', gridTabs.join('|') === 'Undecided 1482|Selected 96|Excluded 2310|All|Auto sorting', gridTabs.join('|'))
  await page.keyboard.press('Escape')
  check('Esc no longer closes Triage', (await page.locator('.triage-panel').count()) === 1)
  check('the toolbar button also switches to the tab', await (async () => { await page.locator('.view-switch .scope-tab', { hasText: 'Search' }).click(); await page.locator('.titlebar-actions .tb-btn', { hasText: 'Triage' }).click(); return (await page.locator('.triage-panel').count()) === 1 })())

  // --- Auto sorting, trained ---
  await page.locator('.triage-controls .scope-tab', { hasText: 'Auto sorting' }).click()
  await page.waitForSelector('.as-tab .as-sort')
  check('grid controls are off, with the one-line note', (await page.locator('.triage-controls .search-input, .triage-controls .triage-cols, .triage-controls .triage-sort').count()) === 0 && (await text('.triage-auto-note')) === 'Search, grid size and date grouping apply to the first four tabs only.')
  check('Import, Paste, Rescan and Change folder stay in the head', (await page.locator('.triage-head-actions button').count()) === 4)
  check('status line: trained on 312 choices', (await text('.as-status')).includes('on 312 of your choices (228 kept, 84 binned).'), await text('.as-status'))
  const sortText = await text('.as-sort')
  check('Sort now: period count sentence', sortText.includes('630 undecided screenshots were taken in the last 30 days (1,482 undecided in all).'), sortText)
  check('Sort now: service line with the allowance', sortText.includes('Haiku is on. Unsure ones go to Haiku, within tonight’s allowance of 300. You confirm the count and cost before anything is sent.'), sortText)
  check('one Sort now button, one Period select', (await page.locator('button', { hasText: /^Sort now$/ }).count()) === 1 && (await page.locator('select.sorter-period-select').count()) === 1)
  check('no Teach the sorter button and no chart', (await page.getByText('Teach the sorter').count()) === 0 && (await page.locator('.as-tab svg').count()) === 0)
  check('Training: heading, balance bar, train again', (await text('.as-training')).includes('312 choices so far.') && (await text('.as-training')).includes('228 kept') && (await page.locator('.as-train', { hasText: 'Train again and test' }).count()) === 1)
  check('the accuracy table is behind "show"', (await page.locator('.sorter-table').count()) === 0)
  await page.locator('.as-accuracy-toggle').click()
  check('"show" opens the table and thresholds', (await page.locator('.sorter-table').count()) === 1 && (await text('.as-training')).includes('Throwaway needs 90% certainty; keep needs 80%.'))
  await page.locator('.as-accuracy-toggle').click()
  const nightly = await text('.as-nightly')
  check('Nightly: switch on at 02:00, the text, next run', (await page.locator('.as-nightly input[type=checkbox]').isChecked()) && (await page.locator('.as-nightly .as-time').inputValue()) === '02:00' && nightly.includes('up to 300 a night (nightly sort and Sort now together)') && /Next: /.test(nightly), nightly)
  const last = await text('.as-last')
  check('Last run: 571 / 41 / 58 and the waiting line', last.includes('nightly sort, today 02:00 · 612 looked at') && last.includes('571') && last.includes('sorted confidently, 17 of them settled by Haiku') && last.includes('41') && last.includes('58') && last.includes('unsure ones sent to Haiku') && last.includes('Waiting for you: 331 proposed keep, 240 proposed throwaway, 41 need a look.'), last)
  const side = await text('.as-side')
  check('side card: service state and Change in Settings', side.includes('Haiku is on') && side.includes('Second opinions on · key saved') && side.includes('Unsure screenshots go to Haiku at 02:00, up to 300 a night.') && side.includes('Change in Settings →'), side)
  await shoot(page, 'auto-sorting-1-trained.png')

  // grid keys are off
  await page.keyboard.press('s')
  await page.keyboard.press('Space')
  check('grid keys do nothing on Auto sorting', (await fake(() => window.__fake.calls.decide)) === 0)

  // nightly switch + time go to main
  await page.locator('.as-nightly .as-switch').click()
  check('the nightly switch calls setNightly(false)', JSON.stringify(await fake(() => window.__fake.calls.setNightly)) === '[false]')
  await page.locator('.as-nightly .as-switch').click()

  // --- Sort now with a service on: confirm box, then send ---
  await page.locator('button', { hasText: /^Sort now$/ }).click()
  await page.waitForSelector('.sorter-cloud-confirm')
  const dlg = await text('.sorter-cloud-confirm')
  check('Sort now raises the confirm box with count and cost', dlg.includes('58 screenshots') && dlg.includes('about $0.12') && (await fake(() => window.__fake.calls.prepare)) === 1 && (await fake(() => window.__fake.calls.sort)) === 0, dlg)
  check('nothing was sent before the click', (await fake(() => window.__fake.calls.send.length)) === 0)
  await page.locator('button', { hasText: 'Not now' }).click()
  check('Not now sends nothing', (await fake(() => window.__fake.calls.send.length)) === 0 && (await page.locator('.sorter-cloud-confirm').count()) === 0)
  await page.locator('button', { hasText: /^Sort now$/ }).click()
  await page.locator('button.sorter-cloud-send').click()
  await page.waitForSelector('.sorter-cloud-result')
  check('Send passes main only the one-time token', JSON.stringify(await fake(() => window.__fake.calls.send)) === '["tok-1"]')
  check('the result line follows', (await text('.sorter-cloud-result')).startsWith('Asked Haiku about 58 screenshots'))
  await page.locator('.sorter-period-select').selectOption('7d')
  check('Period select goes to setPeriod', (await fake(() => window.__fake.sorter.period)) === '7d')
  await page.locator('.sorter-period-select').selectOption('30d')

  // --- during a sort (frame S3) ---
  await fake(() => { Object.assign(window.__fake.sorter, { phase: 'sorting', done: 214, total: 630 }); window.__fake.push() })
  await page.waitForSelector('.as-working')
  check('during a sort: "Sorting 214 of 630 · last 30 days", progress and Stop', (await text('.as-working')).includes('Sorting 214 of 630 · last 30 days') && (await page.locator('.as-working progress').count()) === 1 && (await page.locator('.as-working button', { hasText: 'Stop' }).count()) === 1)
  check('the rest steps back and the Sort now button is gone', (await page.locator('.as-dim').count()) >= 2 && (await page.locator('.as-sort').count()) === 0)
  check('a dot on the Auto sorting tab and on the title bar Triage tab', (await page.locator('.triage-controls .scope-tab.new .pulse-dot').count()) === 1 && (await page.locator('.view-switch .pulse-dot').count()) === 1)
  await shoot(page, 'auto-sorting-3-sorting.png')
  await page.locator('.as-working button', { hasText: 'Stop' }).click()
  check('Stop cancels the sorter', (await fake(() => window.__fake.calls.cancel)) === 1)
  await fake(() => { Object.assign(window.__fake.cloud, { phase: 'asking', done: 20, total: 58 }); Object.assign(window.__fake.sorter, { phase: 'idle', done: 0, total: 0 }); window.__fake.push() })
  await page.waitForFunction(() => /Asking Haiku · 20 of 58/.test(document.querySelector('.as-working')?.textContent ?? ''))
  await page.locator('.as-working button', { hasText: 'Stop' }).click()
  check('asking phase: Stop cancels the service run', (await fake(() => window.__fake.calls.cloudCancel)) === 1)
  await fake(() => { Object.assign(window.__fake.cloud, { phase: 'idle', done: 0, total: 0 }); window.__fake.push() })
  await page.waitForSelector('.as-sort')
  check('the dot goes when nothing runs', (await page.locator('.pulse-dot').count()) === 0)

  // --- no service: one local sort ---
  await fake(() => { window.__fake.cloud.settings.enabled = false; window.__fake.push() })
  await page.waitForFunction(() => /No service is chosen in Settings/.test(document.querySelector('.as-sort')?.textContent ?? ''))
  await page.locator('button', { hasText: /^Sort now$/ }).click()
  await page.waitForSelector('.sorter-cloud-result')
  check('with no service, Sort now runs only the local sort', (await fake(() => window.__fake.calls.sort)) === 1 && (await fake(() => window.__fake.calls.prepare)) === 2 && (await text('.sorter-cloud-result')) === 'Sorted 630 from the last 30 days: 300 keep, 250 throwaway, 80 need a look.', await text('.sorter-cloud-result'))
  check('nightly is disabled with the reason', (await page.locator('.as-nightly input[type=checkbox]').isDisabled()) && (await text('.as-nightly')).includes('When no service is chosen in Settings, nightly sorting is off.'))
  check('the side card says no service is chosen', (await text('.as-side')).includes('No service is chosen'))
  await fake(() => { window.__fake.cloud.settings.enabled = true; window.__fake.push() })

  // --- Review what it sorted, Change in Settings ---
  await page.locator('.as-review-link').click()
  await page.waitForSelector('.rv-screen')
  check('"Review what it sorted" switches to Review', (await page.locator('.view-switch .scope-tab.active').innerText()).startsWith('Review'))
  await page.locator('.view-switch .scope-tab', { hasText: 'Triage' }).click()
  await page.locator('.as-side .as-link').click()
  await page.waitForSelector('.settings-modal')
  check('"Change in Settings" opens Settings', (await page.locator('.settings-modal').count()) === 1)

  // --- Settings › Screenshot sorter (frame S4) ---
  const sec = page.locator('.settings-modal .sorter-settings')
  await sec.scrollIntoViewIfNeeded()
  const st = await sec.innerText()
  check('Settings: intro, service choice, agreement, second opinions, pointer', st.includes('The sorter runs on this Mac.') && st.includes('Off') && st.includes('Luna from OpenAI') && st.includes('Haiku from Anthropic') && /You agreed on 3 Oct/.test(st) && st.includes('Second opinions') && st.includes('Training, sorting and the nightly run are in Triage → Auto sorting.'), st)
  check('Settings no longer holds training, period, sort buttons or nightly', (await sec.locator('select, .pic-primary:not(.nothing), input[type=time]').count()) === 0 && !/Train |Sort now|Sort undecided|every night/.test(st))
  check('the service control shows Haiku selected', await sec.locator('input.sorter-cloud-provider-anthropic').isChecked())
  await shoot(page, 'auto-sorting-4-settings-full.png')
  await sec.screenshot({ path: screens ? join(screens, 'auto-sorting-4-settings.png') : undefined })
  await sec.locator('input.sorter-cloud-provider-off').click()
  check('Off is one setSettings({enabled:false})', JSON.stringify(await fake(() => window.__fake.calls.setSettings.at(-1))) === '{"enabled":false}' && !(await fake(() => window.__fake.cloud.settings.enabled)))
  await sec.locator('input.sorter-cloud-provider-openai').click()
  check('Luna is one setSettings({provider, enabled})', JSON.stringify(await fake(() => window.__fake.calls.setSettings.at(-1))) === '{"provider":"openai","enabled":true}')
  await sec.locator('input.sorter-cloud-provider-anthropic').click()
  await sec.locator('.as-switch').click()
  check('second opinions go to setSecondOpinions', JSON.stringify(await fake(() => window.__fake.calls.setSecond)) === '[false]')
  await sec.locator('.sorter-open-auto').click()
  await page.waitForSelector('.as-tab')
  check('the pointer closes Settings and opens Auto sorting', (await page.locator('.settings-modal').count()) === 0 && (await page.locator('.triage-controls .scope-tab.new.active').count()) === 1)

  // --- never trained (frame S2) ---
  await fake(() => { Object.assign(window.__fake.sorter, { report: null, canRunUnattended: false, lastRun: null, pending: { keep: 0, throwaway: 0, doubtful: 0, lastProposedAt: null } }); window.__fake.push() })
  await page.waitForSelector('.as-untrained')
  const un = await text('.as-untrained')
  check('never trained: what the sorter does, the counts, the train button', un.includes('The sorter has not been trained yet.') && un.includes('You have made 312 choices it can learn from: 228 kept and 84 binned. That is enough to start.') && un.includes('Train on my past choices and test') && un.includes('Holds back about a fifth (62) of your choices'), un)
  check('never trained: Sort now is disabled with the reason, nightly says train first', (await page.locator('button.as-sort-btn').isDisabled()) && (await text('.as-sort')).includes('Train the sorter first. Sorting stays off until it has been trained and tested.') && (await text('.as-nightly')).includes('Train the sorter first.') && (await page.locator('.as-training, .as-last').count()) === 0)
  await shoot(page, 'auto-sorting-2-not-trained.png')
  await page.locator('.as-train').click()
  check('Train goes to sorter.train', (await fake(() => window.__fake.calls.train)) === 1)

  check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser.close()
  await server.close()
}
console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
process.exit(failed ? 1 : 0)
