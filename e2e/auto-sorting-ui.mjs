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
    grouping: { groups: 1, largest: 1, cosine: 0.9, minutes: 1 }, enoughToMeasure: true, trainedOn: { keep: 182, throwaway: 67 }, l2: 1,
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
  const calls = { sort: 0, train: 0, prepare: 0, send: [], cancel: 0, cloudCancel: 0, decide: 0, setSettings: [], setNightly: [], setSecond: [], list: [], decideAll: [], setAppRule: [], runPiles: [], runPage: [] }
  // --- ticket 20 (main) for ticket 21 (renderer): apps, per-app rules, sort runs. Invented numbers and titles. ---
  // one row per app: his kept / thrown away / still undecided, the built-in rule for the app name, his rule ('' = app not known)
  const apps = [
    { app: 'Brightloom', kept: 40, thrownAway: 11, undecided: 412, builtIn: null, rule: null },
    { app: 'Claude', kept: 2, thrownAway: 19, undecided: 60, builtIn: 'keep', rule: null },
    { app: 'Quillpad', kept: 17, thrownAway: 9, undecided: 188, builtIn: null, rule: null },
    { app: 'TalkWeaver', kept: 4, thrownAway: 60, undecided: 214, builtIn: 'throwaway', rule: null },
    { app: 'Mossgrid', kept: 3, thrownAway: 47, undecided: 97, builtIn: null, rule: null },
    { app: 'Finder', kept: 1, thrownAway: 118, undecided: 74, builtIn: 'throwaway', rule: null },
    { app: '', kept: 28, thrownAway: 60, undecided: 305, builtIn: null, rule: null }
  ]
  const WORDS = { keep: { says: 'keep', did: 'kept', control: 'Usually keep' }, throwaway: { says: 'throw away', did: 'threw away', control: 'Usually throw away' } }
  // the same rule as main (sorter/app-rules.ts suggestionFor): 20 decided, 85% one way, rule in force does not say so already
  const suggest = (a) => {
    const decided = a.kept + a.thrownAway
    const way = a.kept >= a.thrownAway ? 'keep' : 'throwaway'
    const most = Math.max(a.kept, a.thrownAway)
    const inForce = a.rule ?? a.builtIn
    if (decided < 20 || most * 100 < 85 * decided || inForce === way) return null
    const share = most / decided
    const did = `you ${WORDS[way].did} ${Math.round(share * 100)}%`
    if (!inForce) return { kind: 'make', rule: way, share, against: null, text: `Y${did.slice(1)} — make it a rule?`, action: 'Make rule' }
    return { kind: 'change', rule: way, share, against: a.rule ? 'yours' : 'built-in', text: `${a.rule ? 'Your rule' : 'Built-in rule'} says ${WORDS[inForce].says}, but ${did} — change to ${WORDS[way].control}?`, action: 'Change rule' }
  }
  const goesBy = () => ({
    apps: apps.map((a) => ({ app: a.app, kept: a.kept, keptShare: a.kept + a.thrownAway ? a.kept / (a.kept + a.thrownAway) : null, thrownAway: a.thrownAway, undecided: a.undecided, builtIn: a.builtIn, rule: a.rule, suggestion: suggest(a) })),
    builtIn: { keep: ['Claude or ChatGPT answer', 'Slides on screen', 'Looks like a chart'], throwaway: ['TalkWeaver, WriteFlex or SlideWell screen', 'Terminal window', 'System Settings window', 'Finder window'] }
  })
  const appOf = (name) => apps.find((a) => a.app.toLowerCase() === String(name).trim().toLowerCase())
  const appCounts = (state) =>
    apps
      .map((a) => ({ app: a.app, count: state === 'undecided' ? a.undecided : state === 'excluded' ? a.thrownAway : state === 'selected' ? a.kept : state === 'all' ? a.undecided + a.kept + a.thrownAway : 0, kept: a.kept, thrownAway: a.thrownAway, keptShare: a.kept / (a.kept + a.thrownAway) }))
      .filter((a) => a.count > 0)
  // sort runs, newest first; each run's cards are made once, his later decisions kept beside them
  const runDefs = [
    { id: 'run-a', startedAt: today(14, 19), finishedAt: today(14, 20), period: '30d', trigger: 'manual', n: [41, 73, 12] },
    { id: 'run-b', startedAt: today(2, 0), finishedAt: today(2, 1), period: 'all', trigger: 'nightly', n: [20, 22, 6] },
    { id: 'run-c', startedAt: new Date(Date.now() - 2 * 86400000).toISOString(), finishedAt: new Date(Date.now() - 2 * 86400000 + 60000).toISOString(), period: '7d', trigger: 'manual', n: [50, 30, 8] }
  ]
  const WHO = ['rules', 'history', 'luna', 'haiku']
  const CARD_APPS = ['Brightloom', 'Quillpad', 'TalkWeaver', 'Mossgrid', 'Finder', null]
  const REASONS = { keep: ['Looks like a chart — usually kept', 'Looks like screenshots you kept before', 'A diagram with labels'], throwaway: ['TalkWeaver, WriteFlex or SlideWell screen — usually throwaway', 'Finder window — usually throwaway; looks like screenshots you binned before', 'Looks like screenshots you binned before'], doubtful: ['Not sure: it looks a bit like screenshots you kept, but not clearly'] }
  const decisions = {} // hash → 'selected' | 'excluded'
  const cardsOf = {}
  for (const r of runDefs) {
    cardsOf[r.id] = []
    ;['keep', 'throwaway', 'doubtful'].forEach((proposal, pi) => {
      for (let i = 0; i < r.n[pi]; i++) {
        const low = i % 5 === 2
        const confidence = proposal === 'doubtful' ? (low ? 0.55 : 0.66) : proposal === 'keep' ? (low ? 0.74 : 0.93) : low ? 0.92 : 0.97
        cardsOf[r.id].push({ hash: `${r.id}-${proposal[0]}${i}`, filename: `Invented capture ${r.id} ${proposal} ${i}.png`, app: CARD_APPS[i % CARD_APPS.length], windowTitle: CARD_APPS[i % CARD_APPS.length] ? `Invented window ${i}` : null, takenAt: null, reason: REASONS[proposal][i % REASONS[proposal].length], confidence, lowConfidence: low, proposal, decidedBy: proposal === 'doubtful' ? null : WHO[i % WHO.length], thumbUrl: null, offline: false })
      }
    })
  }
  const pileNow = (c) => (decisions[c.hash] === 'selected' ? 'kept' : decisions[c.hash] === 'excluded' ? 'throwaway' : c.proposal === 'keep' ? 'kept' : c.proposal === 'throwaway' ? 'throwaway' : 'unsure')
  const cardNow = (c) => ({ ...c, pile: pileNow(c), decision: decisions[c.hash] ?? null })
  const runNow = (r) => {
    const cs = cardsOf[r.id].map(cardNow)
    const n = (p) => cs.filter((c) => c.pile === p).length
    return { id: r.id, startedAt: r.startedAt, finishedAt: r.finishedAt, period: r.period, trigger: r.trigger, counts: { sorted: r.n[0] + r.n[1] + r.n[2], kept: r.n[0], thrownAway: r.n[1], unsure: r.n[2] }, now: { kept: n('kept'), thrownAway: n('throwaway'), unsure: n('unsure') } }
  }
  const pageOf = (runId, pile, after, limit) => {
    const all = (cardsOf[runId] ?? []).map(cardNow).filter((c) => c.pile === pile)
    const from = after ? Number(after) : 0
    const size = limit ?? 60
    return { total: all.length, items: all.slice(from, from + size), next: from + size < all.length ? String(from + size) : null }
  }
  const bulk = { drift: 0 } // set drift to make the next decideAll count differ (the refused case)
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
    sorter, cloud, calls, push, apps, decisions, runDefs, bulk,
    install(sw) {
      sw.sorter = {
        status: async () => ({ ...sorter }),
        train: async () => { calls.train++; return { ok: true } },
        sort: async () => { calls.sort++; return { ok: true, sorted: 630, counts: { keep: 300, throwaway: 250, doubtful: 80 }, periodPhrase: ' from the last 30 days' } },
        setPeriod: async (p) => { sorter.period = p; cloud.period = p; sorter.undecided = { period: p, inPeriod: p === 'all' ? null : 100, all: 1482 }; push(); return { ok: true, period: p } },
        cancel: async () => { calls.cancel++ },
        goesBy: async () => goesBy(),
        setAppRule: async (app, rule) => {
          calls.setAppRule.push([app, rule])
          const a = appOf(app)
          if (!a || !(rule === null || rule === 'keep' || rule === 'throwaway')) return { ok: false, error: 'That is not a rule the sorter knows.', goesBy: goesBy() }
          a.rule = rule
          return { ok: true, goesBy: goesBy() }
        },
        runs: async () => runDefs.map(runNow),
        runPiles: async (runId, opts = {}) => {
          calls.runPiles.push(runId)
          const r = runDefs.find((x) => x.id === runId)
          return { run: r ? runNow(r) : null, kept: pageOf(runId, 'kept', null, opts.kept), throwaway: pageOf(runId, 'throwaway', null, opts.throwaway), unsure: pageOf(runId, 'unsure', null, opts.unsure) }
        },
        runPage: async (runId, pile, after, limit) => { calls.runPage.push([runId, pile, after]); return pageOf(runId, pile, after, limit) },
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
      // the sixth argument is the app filter (calls.list keeps every call's arguments)
      sw.triage.list = async (...a) => { calls.list.push(a); return { ...(await list(...a)), counts: { undecided: 1530, selected: 96, included: 0, excluded: 2310, total: 3888 } } }
      const decide = sw.triage.decide
      // a pile card moved across is his decision by hash; the piles read it back
      sw.triage.decide = async (...a) => {
        calls.decide++
        const [hash, action] = a
        if (action === 'reset') delete decisions[hash]
        else decisions[hash] = action === 'exclude' ? 'excluded' : 'selected'
        return decide(...a)
      }
      sw.triage.apps = async (state) => appCounts(state)
      sw.triage.decideAll = async (names, action, expected) => {
        calls.decideAll.push([names, action, expected])
        const picked = names.map(appOf).filter(Boolean)
        const count = picked.reduce((n, a) => n + a.undecided, 0) + bulk.drift
        bulk.drift = 0
        if (count !== expected) return { ok: false, changed: 0, count, refused: 'count-changed' }
        for (const a of picked) {
          if (action === 'exclude') a.thrownAway += a.undecided
          else a.kept += a.undecided
          a.undecided = 0
        }
        return { ok: true, changed: count, count }
      }
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
  check('tabs: Undecided, Selected, Excluded, All, Auto sorting', gridTabs.join('|') === 'Undecided 1530|Selected 96|Excluded 2310|All|Auto sorting', gridTabs.join('|'))
  const ph = await page.evaluate(() => { const el = document.querySelector('.triage-controls .search-input'); const cs = getComputedStyle(el); const c = document.createElement('canvas').getContext('2d'); c.font = cs.font; return { text: c.measureText(el.placeholder).width, room: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) } })
  check('Triage search placeholder fits at 1440 wide', ph.text <= ph.room, JSON.stringify(ph))
  await shoot(page, 'auto-sorting-0-undecided.png')
  await page.keyboard.press('Escape')
  check('Esc no longer closes Triage', (await page.locator('.triage-panel').count()) === 1)
  await page.locator('.view-switch .scope-tab', { hasText: 'Search' }).click()
  check('the redundant toolbar Triage button is gone', (await page.locator('.titlebar-actions .tb-btn', { hasText: 'Triage' }).count()) === 0)
  await page.locator('.view-switch .scope-tab', { hasText: 'Triage' }).click()

  // --- App menu and bulk bar on Undecided (locked drawing 1b) ---
  const fakeCalls = (k) => fake((key) => window.__fake.calls[key], k)
  check('toolbar: App button sits after search and before Sort', (await page.locator('.triage-controls .tam-btn').innerText()) === 'App ▾' && (await page.locator('.triage-controls > .search-input + .tam-wrap + .triage-sort').count()) === 1)
  check('no bulk bar while no app is ticked', (await page.locator('[data-testid=app-bar]').count()) === 0)
  await page.locator('.tam-btn').click()
  await page.waitForSelector('.tam-pop .tam-app')
  const rowsText = (await page.locator('.tam-pop .tam-app').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim())
  check('menu rows: app, count for this tab, kept before; "App not known" last', rowsText.length === 7 && rowsText[0] === 'Brightloom 412 78%' && rowsText[3] === 'TalkWeaver 214 6%' && rowsText[6] === 'App not known 305 32%', rowsText.join(' | '))
  await page.locator('.tam-app', { hasText: 'TalkWeaver' }).click()
  await page.locator('.tam-app', { hasText: 'Mossgrid' }).click()
  check('ticking labels the button "App: A, B" and the footer counts', (await page.locator('.tam-btn').innerText()).startsWith('App: TalkWeaver, Mossgrid') && (await text('.tam-foot')).includes('2 apps ticked'))
  await shoot(page, 'new-1-app-menu.png')
  await page.keyboard.press('Escape')
  check('Esc closes the menu and keeps the ticks', (await page.locator('.tam-pop').count()) === 0 && (await page.locator('.tam-btn').innerText()).startsWith('App: TalkWeaver'))
  const lastList = await fake(() => window.__fake.calls.list.at(-1))
  check('the list is asked for the ticked apps', JSON.stringify(lastList[5]) === '["TalkWeaver","Mossgrid"]', JSON.stringify(lastList))
  const bar = await text('[data-testid=app-bar]')
  check('bar: "311 undecided from 2 apps", the split, kept before, both buttons', bar.includes('311 undecided from 2 apps') && bar.includes('TalkWeaver 214, Mossgrid 97.') && bar.includes('You kept 6% of both before.') && bar.includes('Exclude all 311') && bar.includes('Select all 311'), bar)
  await page.locator('.tam-exclude').click()
  const ask = await text('.tri-confirm')
  check('Exclude all asks once, naming the count and the apps', ask.includes('Exclude all 311 undecided screenshots from 2 apps?') && (await fakeCalls('decideAll')).length === 0, ask)
  await page.locator('.tri-confirm button', { hasText: 'Not now' }).click()
  check('Not now decides nothing', (await fakeCalls('decideAll')).length === 0 && (await page.locator('.tri-confirm').count()) === 0)
  await page.locator('.tam-exclude').click()
  await page.locator('.tam-confirm-go').click()
  await page.waitForSelector('.tam-result')
  check('confirming sends the apps, the action and the shown count; the result is shown', JSON.stringify(await fakeCalls('decideAll')) === '[[["TalkWeaver","Mossgrid"],"exclude",311]]' && (await text('.tam-result')) === 'Excluded 311 screenshots from 2 apps.', await text('.tam-result'))
  await page.locator('.tam-btn').click()
  await page.locator('.tam-foot .tam-clear').click()
  await page.locator('.tam-app', { hasText: 'Brightloom' }).click()
  await page.keyboard.press('Escape')
  const one = await text('[data-testid=app-bar]')
  check('one app: "412 undecided from Brightloom" and the kept-before sentence', one.includes('412 undecided from Brightloom') && one.includes('You kept 78% of the Brightloom screenshots you decided on before.'), one)
  await fake(() => { window.__fake.bulk.drift = 1 })
  await page.locator('.tam-select').click()
  await page.locator('.tam-confirm-go').click()
  await page.waitForFunction(() => document.querySelector('.tam-result')?.textContent === 'The count changed. Nothing was decided.')
  check('a refused bulk decision says so, and the apps are unchanged', (await fake(() => window.__fake.apps.find((a) => a.app === 'Brightloom').undecided)) === 412)
  await shoot(page, 'new-1b-app-bar.png')
  await page.locator('.tam-btn').click()
  await page.locator('.tam-foot .tam-clear').click()
  await page.keyboard.press('Escape')
  check('Clear empties the filter and the bar', (await page.locator('.tam-btn').innerText()) === 'App ▾' && (await page.locator('[data-testid=app-bar]').count()) === 0 && (await fake(() => window.__fake.calls.list.at(-1)))[5] === undefined)

  // --- Auto sorting, trained ---
  await page.locator('.triage-controls .scope-tab', { hasText: 'Auto sorting' }).click()
  await page.waitForSelector('.as-tab .as-sort')
  check('grid controls are off, with the one-line note', (await page.locator('.triage-controls .search-input, .triage-controls .triage-cols, .triage-controls .triage-sort').count()) === 0 && (await text('.triage-auto-note')) === 'Search, grid size and date grouping apply to the first four tabs only.')
  check('Import, Paste, Rescan and Change folder stay in the head', (await page.locator('.triage-head-actions button').count()) === 4)
  check('status line: trained on 312 choices', (await text('.as-status')).includes('on 312 of your choices.'), await text('.as-status'))
  const sortText = await text('.as-sort')
  check('Training: no "since" sentence when nothing is new', !(await text('.as-training')).includes('you have made'))
  check('Sort now: period count sentence', sortText.includes('630 undecided pictures from the last 30 days can be sorted (1,482 in all).'), sortText)
  check('Sort now: Triage count sentence', sortText.includes('Triage counts 1,530 undecided files; videos, files not downloaded to this Mac and extra copies of the same picture are not sorted.'), sortText)
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
  check('the old Last run block is gone; its link stays', (await page.locator('.as-last').count()) === 0 && (await page.locator('.as-review-link').count()) === 1)
  const side = await text('.as-side')
  check('side card: service state and Change in Settings', side.includes('Haiku is on') && side.includes('Second opinions on · key saved') && side.includes('Unsure screenshots go to Haiku at 02:00, up to 300 a night.') && side.includes('Change in Settings →'), side)
  await shoot(page, 'auto-sorting-1-trained.png')
  await fake(() => { window.__fake.sorter.learnable = { kept: 240, binned: 90 }; window.__fake.push() })
  await page.waitForFunction(() => document.querySelector('.as-training')?.textContent?.includes('you have made'))
  check('Training: since-training sentence when new choices exist', (await text('.as-training')).includes('330 choices so far.') && (await text('.as-training')).includes('It last trained on 312 of them; you have made 18 since. Train again to include them.'), await text('.as-training'))
  await shoot(page, 'auto-sorting-1b-new-choices.png')
  await fake(() => { window.__fake.sorter.learnable = { kept: 228, binned: 84 }; window.__fake.push() })

  // grid keys are off
  await page.keyboard.press('s')
  await page.keyboard.press('Space')
  check('grid keys do nothing on Auto sorting', (await fake(() => window.__fake.calls.decide)) === 0)

  // --- What the sorter goes by (locked drawing 2) ---
  check('section heading sits under the status line, above Sort now', (await page.locator('.as-main > div:has(.as-status) + .gb .gb-title').innerText()) === 'What the sorter goes by' && (await page.locator('.gb ~ .as-sort').count()) === 1)
  const rowOf = (app) => page.locator(`.gb-table tr[data-app="${app}"]`)
  const brightloom = (await rowOf('Brightloom').innerText()).replace(/\s+/g, ' ')
  check('table row: kept with share, thrown away, still undecided', brightloom.startsWith('Brightloom 40 78% 11 412'), brightloom)
  check('"App not known" is the last row', (await page.locator('.gb-table tbody tr').last().innerText()).startsWith('App not known'))
  check('built-in rule: muted, labelled, no chip when it agrees', (await rowOf('TalkWeaver').locator('label.on.bi').innerText()) === 'Usually throw away' && (await rowOf('TalkWeaver').innerText()).includes('Built-in rule') && (await rowOf('TalkWeaver').locator('.gb-chip').count()) === 0)
  const claude = (await rowOf('Claude').innerText()).replace(/\s+/g, ' ')
  check('clash: built-in keep with the chip text and button from main', claude.includes('Built-in rule') && claude.includes('Built-in rule says keep, but you threw away 90% — change to Usually throw away? Change rule'), claude)
  check('built-in rules in two groups, wording from main', (await text('.gb-side')).toLowerCase().includes('usually kept') && (await text('.gb-side')).includes('Claude or ChatGPT answer') && (await text('.gb-side')).includes('Finder window') && (await text('.gb-side')).toLowerCase().includes('how the picture looks'))
  await page.locator('.gb-table tr[data-app="Mossgrid"] .gb-chip-btn').click()
  await page.waitForSelector('.gb-saved')
  check('"Make rule" saves that rule at once and says when it is used', JSON.stringify(await fakeCalls('setAppRule')) === '[["Mossgrid","throwaway"]]' && (await text('.gb-saved')).includes('Used from the next sort.') && (await rowOf('Mossgrid').locator('.gb-chip').count()) === 0 && (await rowOf('Mossgrid').locator('label.on:not(.bi)').innerText()) === 'Usually throw away')
  await rowOf('Brightloom').locator('label', { hasText: 'Usually keep' }).click()
  await page.waitForFunction(() => window.__fake.calls.setAppRule.length === 2)
  check('the three-way control saves the choice', JSON.stringify(await fakeCalls('setAppRule')) === '[["Mossgrid","throwaway"],["Brightloom","keep"]]' && (await rowOf('Brightloom').locator('label.on').innerText()) === 'Usually keep')
  await rowOf('Brightloom').locator('label', { hasText: 'No rule' }).click()
  await page.waitForFunction(() => window.__fake.calls.setAppRule.length === 3)
  await page.locator('.gb').evaluate((e) => e.scrollIntoView({ block: 'start' }))
  await shoot(page, 'new-2-what-the-sorter-goes-by.png')

  // --- piles of the latest sort (locked drawing 3a) ---
  check('the chooser names the latest sort', /^Sort of today 14:\d\d · 126/.test(await text('.sp-chooser-btn')), await text('.sp-chooser-btn'))
  check('result line carries the numbers the sort ended with', (await text('.sp-result')).startsWith('Sorted 126 from the last 30 days: 41 kept, 73 thrown away, 12 unsure.'), await text('.sp-result'))
  const heads = (await page.locator('.sp h3').allInnerTexts()).map((t) => t.replace(/\s+/g, ' '))
  check('Kept and Thrown away side by side, Unsure below, headed with live counts', heads[0] === 'Kept 41' && heads[1] === 'Thrown away 73' && heads[2].startsWith('Unsure 12'), heads.join(' | '))
  const sides = await page.evaluate(() => { const k = document.querySelector('.sp-pile[data-pile=kept]').getBoundingClientRect(); const t = document.querySelector('.sp-pile[data-pile=throwaway]').getBoundingClientRect(); const u = document.querySelector('.sp-unsure').getBoundingClientRect(); return k.right <= t.left && Math.abs(k.top - t.top) < 2 && u.top > k.bottom - 1 })
  check('layout: Kept left of Thrown away, Unsure under both', sides)
  const k0 = (await page.locator('.sp-pile[data-pile=kept] .sp-card').first().innerText()).replace(/\s+/g, ' ')
  check('a card shows app, who decided and the reason', /^Brightloom Rules Looks like a chart/.test(k0), k0)
  check('low-confidence cards are marked', (await page.locator('.sp-pile[data-pile=kept] .sp-card.low .sp-low').count()) > 0 && (await page.locator('.sp-pile[data-pile=kept] .sp-card.low .sp-low').first().innerText()) === 'low confidence')
  check('hint bar', (await text('.sp-hints')).includes('move across') && (await text('.sp-hints')).includes('Moving one across counts as one of your choices.'))
  await page.locator('.sp').evaluate((e) => e.scrollIntoView({ block: 'start' }))
  await page.locator('.sp-pile[data-pile=kept] .sp-card').first().focus()
  await shoot(page, 'new-3-piles.png')

  // keys act only on a focused pile card
  await page.locator('.sp-pile[data-pile=kept] .sp-card').first().blur()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('u')
  check('pile keys do nothing while no pile card has focus', (await fakeCalls('decide')) === 0)
  const firstKept = await page.locator('.sp-pile[data-pile=kept] .sp-card').first().getAttribute('data-hash')
  await page.locator('.sp-chooser-btn').click()
  await page.locator('.sp-pile[data-pile=kept] .sp-card').first().focus()
  await page.keyboard.press('ArrowRight')
  check('pile keys do nothing while the chooser is open', (await fakeCalls('decide')) === 0)
  await shoot(page, 'new-3-chooser-open.png')
  const rowsC = (await page.locator('.sp-chooser-row').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim())
  check('chooser lists the sorts newest first, current ticked, with the note', rowsC.length === 3 && rowsC[0].includes('126 sorted · 41 kept, 73 thrown away') && rowsC[1].includes('nightly, everything · 48 sorted') && (await page.locator('.sp-chooser-row.on').count()) === 1 && (await text('.sp-chooser-pop')).includes('A screenshot sorted again later appears only in its latest sort.'), rowsC.join(' | '))
  await page.locator('.sp-chooser-row').nth(1).click()
  await page.waitForFunction(() => document.querySelector('.sp-result')?.textContent?.startsWith('Sorted 48:'))
  check('choosing an earlier sort shows its piles', (await fakeCalls('runPiles')).at(-1) === 'run-b' && (await text('.sp-result')).startsWith('Sorted 48: 20 kept, 22 thrown away, 6 unsure.') && (await text('.sp-chooser-btn')).includes('· 48'), await text('.sp-result'))
  await page.locator('.sp-chooser-btn').click()
  await page.locator('.sp-chooser-row').first().click()
  await page.waitForFunction(() => document.querySelector('.sp-result')?.textContent?.startsWith('Sorted 126'))

  // arrow keys move a card; counts follow
  const card = (pile) => page.locator(`.sp-pile[data-pile=${pile}] .sp-card`)
  await card('kept').first().focus()
  await page.keyboard.press('ArrowLeft')
  check('left on a Kept card does nothing (it is already on the left)', (await fakeCalls('decide')) === 0)
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(() => window.__fake.calls.decide === 1)
  await page.waitForFunction(() => document.querySelector('.sp h3')?.textContent?.includes('40'))
  const heads2 = (await page.locator('.sp h3').allInnerTexts()).map((t) => t.replace(/\s+/g, ' '))
  check('right moves it to Thrown away as his decision; the counts follow', heads2[0] === 'Kept 40' && heads2[1] === 'Thrown away 74' && (await fake(() => window.__fake.decisions))[firstKept] === 'excluded', heads2.join(' | '))
  check('the result line keeps the numbers as the sort ended', (await text('.sp-result')).startsWith('Sorted 126 from the last 30 days: 41 kept, 73 thrown away, 12 unsure.'))
  const moved = page.locator(`.sp-pile[data-pile=throwaway] [data-hash="${firstKept}"]`)
  check('the moved card shows his decision', (await moved.innerText()).includes('You threw it away'))
  check('focus stays in the Kept pile, on the next card', await page.evaluate(() => document.activeElement?.closest('[data-pile]')?.getAttribute('data-pile') === 'kept' && document.activeElement?.hasAttribute('data-card')))
  await moved.focus()
  await page.keyboard.press('ArrowLeft')
  await page.waitForFunction(() => window.__fake.calls.decide === 2)
  check('left on a Thrown away card selects it (Kept again)', (await fake(() => window.__fake.decisions))[firstKept] === 'selected')
  await page.locator(`[data-hash="${firstKept}"]`).focus()
  await page.keyboard.press('u')
  await page.waitForFunction(() => window.__fake.calls.decide === 3)
  check('U marks it undecided again', (await fake(() => window.__fake.decisions))[firstKept] === undefined)
  await page.waitForFunction(() => document.querySelector('.sp h3')?.textContent?.includes('41'))
  await page.locator('.sp-pile[data-pile=throwaway] .sp-card').first().focus()
  await page.keyboard.press('Enter')
  await page.waitForSelector('.sp-open')
  check('Return opens the picture', (await page.locator('.sp-open .lb-title').count()) === 1)
  await page.keyboard.press('Escape')
  check('Esc closes it', (await page.locator('.sp-open').count()) === 0)
  check('unsure cards move too: right excludes', await (async () => { await page.locator('.sp-unsure [data-card]').first().focus(); await page.keyboard.press('ArrowRight'); await page.waitForFunction(() => window.__fake.calls.decide === 4); return (await page.locator('.sp h3').nth(2).innerText()).includes('11') })())
  await fake(() => { for (const k of Object.keys(window.__fake.decisions)) delete window.__fake.decisions[k] })

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
