// End-to-end: the sorter's cloud step (ticket 07) in the real app, hidden, against a local stub of
// the OpenAI Responses API. Synthetic data only: a scratch well whose triage.db holds five generated
// screenshots with sorter proposals (three doubtful, one keep, one throwaway).
//
//   1. Settings window › Sorting help and Accounts and keys: save a made-up key (in Accounts and keys); config.json holds only ciphertext; saving the key
//      does not turn asking Luna on; a send from the renderer without a prepared batch is refused;
//      turning it on raises main's own native dialog (count, cost, what is sent); declined, nothing is
//      recorded; confirmed, main records the time.
//   2. Sort now while "offline" (every https request fails): the confirm dialog shows count + cost;
//      after Send, main's native dialog asks again (declined: nothing sent); confirmed, the run
//      completes with the cloud step skipped and the items stay doubtful.
//   3. Sort now online: only the three doubtful screenshots reach the stub, shrunk to ≤ 1456 px; the
//      answers are recorded under the keep-bias with decided_by 'luna'; Review shows "asked Luna".
//   4. Haiku as the second provider (ticket 16), against a stub of Anthropic's Messages API: choosing
//      Haiku while asking is on raises main's dialog naming Anthropic (declined: still Luna; confirmed:
//      Anthropic's own opt-in is recorded beside OpenAI's); the Anthropic key has its own field and its
//      own ciphertext, and an OpenAI-shaped key is refused there; Sort now shows the list-price estimate
//      and the free-credits line; only the two new doubtful screenshots go, to /v1/messages with
//      x-api-key and no Bearer token; the answers are recorded with decided_by 'haiku' and the model.
//   5. A second opinion (ticket 17): the scratch triage.db starts with the answers table as it was
//      before there was a row per provider, holding one row; the app migrates it on open and the row
//      survives. The Haiku run in step 4 also gets the screenshot Luna was unsure about, shown as its
//      own number in the app's confirm box and in main's dialogs. Back with Luna, the one Haiku was
//      unsure about goes once; after that neither provider is offered anything, whichever is selected.
//   5b. The period: two more doubtful screenshots, one two days old and one over a year old. Main
//      refuses a period that is not one of the four; Last 7 days chosen beside Sort now is stored and
//      shown beside the other sort button; the confirm box and main's dialog name the period and count
//      only it; only the recent one reaches the stub and the old one stays as it was; a period change
//      between the preview and the send invalidates the batch.
//   6. Neither made-up key appears in config.json, the app's stdout/stderr or the profile folder.
//
// Run after `npm run build` (or `npx electron-vite build`):  node e2e/sorter-cloud.mjs
// Optional: SLIDEWELL_CLOUD_SCRATCH (default ~/Library/Caches/slidewell-e2e-sorter-cloud),
//   SLIDEWELL_CLOUD_SCREENS (where screenshots go; default <scratch>/screens).
//
// Isolation: own --user-data-dir, own HOME, --use-mock-keychain (safeStorage works without touching
// the login keychain), SLIDEWELL_E2E_HIDDEN=1. The stub is reached through a test-only https
// interception installed from this script in the main process (protocol.handle); main's native
// consent dialog (dialog.showMessageBox) is replaced the same way, answering from a queue and
// recording what it showed. The app's own code has no stub switch. Nothing goes to the real network.
import { _electron as electron } from 'playwright'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import sharp from 'sharp'

const repo = resolve(import.meta.dirname, '..')
const scratch = resolve(process.env.SLIDEWELL_CLOUD_SCRATCH || join(homedir(), 'Library', 'Caches', 'slidewell-e2e-sorter-cloud'))
const screens = resolve(process.env.SLIDEWELL_CLOUD_SCREENS || join(scratch, 'screens'))
const FAKE_KEY = 'sk-test-E2ELEAKCHECK-0123456789abcdefghijklmnopqrstuv'
const FAKE_ANT_KEY = 'sk-ant-api03-E2EANTLEAKCHECK-0123456789abcdefghijklmn'
const SORTER_VERSION = /SORTER_VERSION = '([^']+)'/.exec(readFileSync(join(repo, 'src/main/sorter/decide.ts'), 'utf8'))[1]

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) failed++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- scratch profile + synthetic well ---
for (const d of ['userData', 'home', 'well', 'source']) rmSync(join(scratch, d), { recursive: true, force: true })
const userData = join(scratch, 'userData')
const well = join(scratch, 'well')
const source = join(scratch, 'source')
for (const d of [userData, join(scratch, 'home'), well, source, screens]) mkdirSync(d, { recursive: true })

const shots = [
  { hash: 'e2e-doubt-keep', proposal: 'doubtful', window: 'keep-chart', colour: '#3b6db3', takenAt: '2026-10-09T10:00:00' },
  { hash: 'e2e-doubt-toss', proposal: 'doubtful', window: 'toss-wifi', colour: '#9aa0a6', takenAt: '2026-10-09T09:00:00' },
  { hash: 'e2e-doubt-unsure', proposal: 'doubtful', window: 'blurry-chat', colour: '#c9a227', takenAt: '2026-10-09T08:00:00' },
  { hash: 'e2e-local-keep', proposal: 'keep', window: 'local-keep', colour: '#2f855a', takenAt: '2026-10-08T10:00:00' },
  { hash: 'e2e-local-toss', proposal: 'throwaway', window: 'local-toss', colour: '#444444', takenAt: '2026-10-08T09:00:00' }
]
// invented CleanShot names (the cloud step sends screenshots only) and real content hashes (it re-hashes before sending)
const nameOf = (s) => `CleanShot ${s.takenAt.slice(0, 10)} at ${s.takenAt.slice(11, 19).replaceAll(':', '.')} from Test App with ${s.window}.png`
const realHash = new Map()
for (const s of shots) {
  const f = join(source, nameOf(s))
  await sharp({ create: { width: 3024, height: 1964, channels: 3, background: s.colour } }).png().toFile(f)
  realHash.set(s.hash, createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 12))
}
{
  const t = new DatabaseSync(join(well, 'triage.db'))
  t.exec(`CREATE VIRTUAL TABLE triage_fts USING fts5(hash UNINDEXED, kind UNINDEXED, rel_path UNINDEXED, filename, ext UNINDEXED, size UNINDEXED, mtime UNINDEXED,
            poster_rel UNINDEXED, offline UNINDEXED, ocr_text, scanned_at UNINDEXED, source UNINDEXED, taken_at UNINDEXED, app, window_title);
          CREATE TABLE triage_decisions (hash TEXT PRIMARY KEY, state TEXT NOT NULL, decided_at TEXT, well_id TEXT);
          CREATE TABLE sorter_proposals (hash TEXT PRIMARY KEY, proposal TEXT NOT NULL, confidence REAL NOT NULL, p_keep REAL NOT NULL, reason TEXT NOT NULL, rule TEXT,
            sorter_version TEXT NOT NULL, model_id TEXT, proposed_at TEXT NOT NULL, throwaway_since TEXT, answered_at TEXT, answer TEXT, decided_by TEXT);`)
  // the answers table as it was before ticket 17 (one row per screenshot), with one row to carry over
  t.exec(`CREATE TABLE sorter_cloud_answers (hash TEXT PRIMARY KEY, verdict TEXT NOT NULL CHECK (verdict IN ('keep', 'throwaway', 'unsure')), confidence REAL NOT NULL,
            reason TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL, asked_at TEXT NOT NULL);`)
  t.prepare("INSERT INTO sorter_cloud_answers (hash, verdict, confidence, reason, model, prompt_version, asked_at) VALUES ('e2e-old-answer', 'unsure', 0.5, 'An earlier answer', 'gpt-6-luna', 'luna-prompt-1', '2026-10-08T02:00:00.000Z')").run()
  const fts = t.prepare("INSERT INTO triage_fts (hash, kind, rel_path, filename, ext, size, mtime, offline, ocr_text, source, taken_at, app, window_title) VALUES (?, 'image', ?, ?, 'png', ?, ?, '0', '', ?, ?, 'Test App', ?)")
  const prop = t.prepare('INSERT INTO sorter_proposals (hash, proposal, confidence, p_keep, reason, rule, sorter_version, model_id, proposed_at, throwaway_since, decided_by) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?)')
  const now = new Date().toISOString()
  for (const s of shots) {
    const f = join(source, nameOf(s))
    const st = statSync(f)
    fts.run(realHash.get(s.hash), nameOf(s), nameOf(s), String(st.size), String(Math.round(st.mtimeMs)), source, s.takenAt, s.window)
    const local = s.proposal === 'doubtful' ? null : 'history'
    prop.run(realHash.get(s.hash), s.proposal, 0.6, s.proposal === 'keep' ? 0.9 : 0.4, s.proposal === 'doubtful' ? `Not sure: local reason for ${s.window}` : 'Looks like screenshots you kept before', SORTER_VERSION, now, s.proposal === 'throwaway' ? now : null, local)
  }
  t.close()
}
writeFileSync(
  join(userData, 'config.json'),
  JSON.stringify({ archiveRoot: join(scratch, 'no-archive'), wellRoot: well, othersArchiveRoot: join(scratch, 'others'), vaultRoot: join(scratch, 'no-vault'), pictureSearch: { paused: true, includeWell: false }, sorterCloud: { since: new Date().toISOString() } }, null, 2),
  'utf8'
)
const answerRows = (where = '1') => {
  const db = new DatabaseSync(join(well, 'triage.db'), { readOnly: true })
  try {
    return { columns: db.prepare("SELECT name, pk FROM pragma_table_info('sorter_cloud_answers')").all(), rows: db.prepare(`SELECT * FROM sorter_cloud_answers WHERE ${where} ORDER BY hash, provider`).all() }
  } finally {
    db.close()
  }
}
const proposal = (hash) => {
  const db = new DatabaseSync(join(well, 'triage.db'), { readOnly: true })
  try {
    return db.prepare('SELECT proposal, decided_by, decided_model, reason FROM sorter_proposals WHERE hash = ?').get(realHash.get(hash))
  } finally {
    db.close()
  }
}

// --- the stub: answers like Luna (/v1/responses) or like Haiku (/v1/messages) by the window title sent beside each picture ---
const seen = []
const seenHaiku = []
const verdictFor = (id, w) => {
  if (w.startsWith('keep')) return { id, verdict: 'keep', confidence: 0.93, reason: 'A chart worth keeping for a slide.' }
  if (w.startsWith('toss')) return { id, verdict: 'throwaway', confidence: 0.97, reason: 'A Wi-Fi settings pane.' }
  return { id, verdict: 'unsure', confidence: 0.5, reason: 'A blurry chat window; hard to tell.' }
}
const answerHaiku = async (req, res, body) => {
  const json = JSON.parse(body)
  const parts = json.messages[0].content
  const lines = parts.filter((p) => p.type === 'text' && p.text.startsWith('id: ')).map((p) => p.text)
  const dims = []
  for (const p of parts.filter((x) => x.type === 'image')) {
    const m = await sharp(Buffer.from(p.source.data, 'base64')).metadata()
    dims.push({ format: m.format, long: Math.max(m.width, m.height), declared: `${p.source.type}:${p.source.media_type}` })
  }
  const windows = lines.map((l) => /window: ([^·]+)/.exec(l)?.[1].trim() ?? '')
  seenHaiku.push({ path: req.url, apiKey: req.headers['x-api-key'], version: req.headers['anthropic-version'], auth: req.headers.authorization, model: json.model, toolChoice: json.tool_choice, tool: json.tools?.[0]?.name, maxTokens: json.max_tokens, windows, dims })
  const items = lines.map((l, i) => verdictFor(/^id: (s\d+)/.exec(l)[1], windows[i]))
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ id: 'msg_e2e', type: 'message', role: 'assistant', model: json.model, content: [{ type: 'tool_use', id: 'toolu_e2e', name: json.tools[0].name, input: { items } }], stop_reason: 'tool_use', usage: { input_tokens: 1000, output_tokens: 50 } }))
}
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', async () => {
    if (req.url === '/v1/messages') return answerHaiku(req, res, body)
    const auth = req.headers.authorization
    const json = JSON.parse(body)
    const parts = json.input[0].content
    const lines = parts.filter((p) => p.type === 'input_text' && p.text.startsWith('id: ')).map((p) => p.text)
    const images = parts.filter((p) => p.type === 'input_image').map((p) => p.image_url)
    const dims = []
    for (const u of images) {
      const m = await sharp(Buffer.from(u.split(',')[1], 'base64')).metadata()
      dims.push({ format: m.format, long: Math.max(m.width, m.height) })
    }
    seen.push({ path: req.url, auth, model: json.model, store: json.store, format: json.text?.format?.type, windows: lines.map((l) => /window: ([^·]+)/.exec(l)?.[1].trim()), dims })
    const items = lines.map((l) => {
      const id = /^id: (s\d+)/.exec(l)[1]
      const w = /window: ([^·]+)/.exec(l)?.[1].trim() ?? ''
      if (w.startsWith('keep')) return { id, verdict: 'keep', confidence: 0.93, reason: 'A chart worth keeping for a slide.' }
      if (w.startsWith('toss')) return { id, verdict: 'throwaway', confidence: 0.97, reason: 'A Wi-Fi settings pane.' }
      return { id, verdict: 'unsure', confidence: 0.5, reason: 'A blurry chat window; hard to tell.' }
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'completed', model: json.model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ items }) }] }], usage: { input_tokens: 1000, output_tokens: 50 } }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const stubUrl = `http://127.0.0.1:${server.address().port}`
console.log(`stub: ${stubUrl}`)

const output = []
const app = await electron.launch({
  args: ['.', `--user-data-dir=${userData}`, '--use-mock-keychain'],
  cwd: repo,
  env: { ...process.env, HOME: join(scratch, 'home'), SLIDEWELL_E2E_HIDDEN: '1' }
})
app.process().stdout?.on('data', (d) => output.push(String(d)))
app.process().stderr?.on('data', (d) => output.push(String(d)))
// test-only https interception: 'offline' fails every request; 'stub' forwards api.openai.com and api.anthropic.com to the stub
const route = (mode) =>
  app.evaluate(async ({ protocol, net }, { mode, stubUrl }) => {
    globalThis.__cloudE2E = globalThis.__cloudE2E ?? { calls: 0 }
    if (protocol.isProtocolHandled('https')) protocol.unhandle('https')
    protocol.handle('https', async (req) => {
      globalThis.__cloudE2E.calls++
      const u = new URL(req.url)
      if (mode === 'offline' || (u.host !== 'api.openai.com' && u.host !== 'api.anthropic.com')) throw new Error('offline (e2e)')
      globalThis.__cloudE2E.hosts = [...(globalThis.__cloudE2E.hosts ?? []), u.host]
      const headers = {}
      req.headers.forEach((v, k) => (headers[k] = v))
      return net.fetch(`${stubUrl}${u.pathname}`, { method: req.method, headers, body: await req.text() })
    })
  }, { mode, stubUrl })

// test-only: main's native consent dialog answers from a queue (true = the confirm button) and records what it showed
const answerDialogs = (answers) =>
  app.evaluate(({ dialog }, answers) => {
    globalThis.__cloudDialogs = globalThis.__cloudDialogs ?? { shown: [], answers: [] }
    globalThis.__cloudDialogs.answers.push(...answers)
    if (!globalThis.__cloudDialogs.patched) {
      globalThis.__cloudDialogs.patched = true
      dialog.showMessageBox = async (win, opts) => {
        const o = opts ?? win
        globalThis.__cloudDialogs.shown.push({ parent: Boolean(opts), message: o.message, detail: o.detail, buttons: o.buttons })
        return { response: globalThis.__cloudDialogs.answers.shift() ? 1 : 0, checkboxChecked: false }
      }
    }
  }, answers)
const dialogsShown = () => app.evaluate(() => globalThis.__cloudDialogs?.shown ?? [])

try {
  await route('offline')
  let win = null
  for (let i = 0; i < 300 && !win; i++) {
    win = app.windows().find((w) => !w.url().startsWith('swembed:') && w.url() !== 'about:blank') ?? null
    if (!win) await sleep(100)
  }
  if (!win) throw new Error('main window did not open')
  await win.waitForLoadState('domcontentloaded')
  await win.setViewportSize({ width: 1440, height: 900 })
  await win.waitForFunction(() => Boolean(window.sw?.cloud))
  // The one Settings window (as e2e/settings.mjs drives it) holds the service (Sorting help), the keys (Accounts and keys)
  // and the agreements; Sort now and the period are in Triage > Auto sorting
  const isSettings = (w) => w.url().endsWith('settings.html')
  const settingsWin = async (sectionId) => {
    let sw = app.windows().find(isSettings)
    if (!sw) [sw] = await Promise.all([app.waitForEvent('window', { timeout: 10000 }), win.locator('.titlebar-actions .tb-btn', { hasText: '⚙' }).click()])
    await sw.waitForSelector('.bsw-root', { timeout: 10000 })
    await sw.locator(`button.bsw-nav[data-section="${sectionId}"]`).click()
    return sw
  }
  const closeSettings = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.getURL().endsWith('settings.html') && w.close()))
  // the Sorting help page: the service choice, one row per key and one per agreement
  let section, openaiRow, anthropicRow
  const gotoSorter = async () => {
    const sw = await settingsWin('sorter-service')
    section = sw.locator('.sorter-cloud')
    await section.waitFor()
    await section.scrollIntoViewIfNeeded()
    openaiRow = section.locator('.sorter-cloud-key-openai')
    anthropicRow = section.locator('.sorter-cloud-key-anthropic')
    return sw
  }
  // Accounts and keys: the slot's "Add key…" form (a password field, cleared when handed over); the value never shown again.
  // Returns the slot row; the form stays open if main refuses the key (a notice appears instead).
  const openKeyForm = async (slotId) => {
    const sw = await settingsWin('accounts')
    const row = sw.locator(`[data-slot="${slotId}"]`)
    await row.getByRole('button', { name: /^(Add|Replace) key…$/ }).click()
    return { sw, row, input: row.locator('input[type=password]') }
  }
  const saveKey = async (slotId, key) => {
    const { row, input } = await openKeyForm(slotId)
    await input.fill(key)
    await row.getByRole('button', { name: 'Add key', exact: true }).click()
    await row.getByText(/Key saved/).waitFor({ timeout: 10000 })
  }
  const openAuto = async () => {
    await closeSettings()
    await win.locator('.view-switch .scope-tab', { hasText: 'Triage' }).click()
    await win.locator('.triage-controls .scope-tab.new').click()
    await win.waitForSelector('.as-sort')
  }
  // The scratch profile has no picture model and no trained sorter, so the tab keeps Sort now disabled (its own
  // rule, shown in e2e/auto-sorting-ui.mjs); React drops clicks on a disabled button, so the button's own onClick is
  // called, which runs main's prepare, the confirm box and the send exactly as a click would.
  const sortNow = async () => {
    await openAuto()
    await win.evaluate(() => {
      const b = document.querySelector('button.sorter-cloud-sort')
      b[Object.keys(b).find((k) => k.startsWith('__reactProps'))].onClick()
    })
  }

  // 1. the key
  await gotoSorter()
  check('Settings shows the Luna section with no key yet, and a way to add a key for each provider (Add key… opens Accounts and keys)', /No key yet/.test(await openaiRow.innerText()) && /No key yet/.test(await anthropicRow.innerText()) && (await openaiRow.locator('button.sorter-open-keys', { hasText: 'Add key…' }).count()) === 1 && (await anthropicRow.locator('button.sorter-open-keys', { hasText: 'Add key…' }).count()) === 1)
  check('Settings says the other provider can be asked once about what the first left unsure', /If Luna was unsure about a screenshot, Haiku can be asked about it once/.test(await section.innerText()) && !/is not sent to the other/.test(await section.innerText()))
  check('the service is Off until he chooses one, Luna being the provider kept', (await section.locator('input.sorter-cloud-provider-off').isChecked()) && !(await section.locator('input.sorter-cloud-provider-anthropic').isChecked()) && (await win.evaluate(() => window.sw.cloud.status())).settings.provider === 'openai')
  await section.screenshot({ path: join(screens, 'sorter-cloud-settings-no-key.png') })
  await openaiRow.locator('button.sorter-open-keys').click()
  check('Add key… on the Sorting help page opens Accounts and keys', await app.windows().find(isSettings).locator('[data-slot="sorting.openaiKey"]').waitFor({ timeout: 5000 }).then(() => true, () => false))
  await saveKey('sorting.openaiKey', FAKE_KEY)
  await gotoSorter()
  await openaiRow.locator('.pic-ready', { hasText: 'Saved' }).waitFor({ timeout: 10000 })
  const st = await win.evaluate(() => window.sw.cloud.status())
  check('status says a key is saved (and carries no key)', st.hasKey === true && !JSON.stringify(st).includes(FAKE_KEY))
  const cfgText = readFileSync(join(userData, 'config.json'), 'utf8')
  const cfg = JSON.parse(cfgText)
  check('config.json holds the key only as ciphertext', !cfgText.includes(FAKE_KEY) && !cfgText.includes('E2ELEAKCHECK') && typeof cfg.sorterCloud?.keyEnc === 'string' && cfg.sorterCloud.keyEnc.length > 20)
  check('saving the key does not turn asking Luna on', st.settings.enabled === false && !cfg.sorterCloud?.optedInAt, JSON.stringify(st.settings))
  const forged = await win.evaluate(() => window.sw.cloud.send(300))
  check('a send without a prepared batch is refused by main', forged.skipped === 'not-prepared' && forged.asked === 0, JSON.stringify(forged))
  const offPrep = await win.evaluate(() => window.sw.cloud.prepare())
  check('while off, Sort now offers nothing to send', offPrep.blocked === 'off' && offPrep.token === null, JSON.stringify(offPrep))
  await answerDialogs([false, true])
  await section.locator('input.sorter-cloud-provider-openai').click() // declined in main's dialog
  for (let i = 0; i < 50 && (await dialogsShown()).length < 1; i++) await sleep(100)
  await sleep(300)
  check('declining main’s dialog leaves asking Luna off', (await win.evaluate(() => window.sw.cloud.status())).settings.enabled === false && !JSON.parse(readFileSync(join(userData, 'config.json'), 'utf8')).sorterCloud?.optedInAt)
  const turnOn = (await dialogsShown())[0]
  check('turning on raises main’s own dialog on the main window: count, cost and what is sent', Boolean(turnOn?.parent) && /3 doubtful screenshots are waiting now/.test(turnOn?.detail ?? '') && /Estimated cost: (about \$|under \$)/.test(turnOn?.detail ?? '') && /app name and window title/.test(turnOn?.detail ?? ''), JSON.stringify(turnOn))
  await section.locator('input.sorter-cloud-provider-openai').click() // controlled input: it ticks once main answers
  await win.waitForFunction(async () => (await window.sw.cloud.status()).settings.enabled === true)
  const optedIn = JSON.parse(readFileSync(join(userData, 'config.json'), 'utf8')).sorterCloud?.optedInAt
  check('turning it on is recorded in main with its time', typeof optedIn === 'string' && Number.isFinite(Date.parse(optedIn)), String(optedIn))
  await section.screenshot({ path: join(screens, 'sorter-cloud-settings.png') })

  // 2. offline
  await sortNow()
  const dialog = win.locator('.sorter-cloud-confirm')
  await dialog.waitFor({ timeout: 20000 })
  const dialogText = await dialog.innerText()
  check('Sort now asks first: count and estimated cost', /Ask Luna about 3 screenshots\?/.test(dialogText) && /Estimated cost: (about \$|under \$)/.test(dialogText), dialogText)
  check('the dialog says the app name and window title go with each picture', /app name and window title/.test(dialogText) && !/Nothing else leaves this Mac/.test(dialogText), dialogText)
  await win.screenshot({ path: join(screens, 'sorter-cloud-confirm.png') })
  check('nothing was sent before the click', seen.length === 0 && (await app.evaluate(() => globalThis.__cloudE2E.calls)) === 0)
  await answerDialogs([false])
  await dialog.locator('button.sorter-cloud-send').click()
  const result0 = win.locator('.sorter-cloud-result')
  await result0.waitFor({ timeout: 60000 })
  const declinedText = await result0.innerText()
  const sendDialog = (await dialogsShown()).at(-1)
  check('Send in the app raises main’s own dialog with count and cost; declined, nothing is sent', /Send 3 screenshots to Luna\?/.test(sendDialog?.message ?? '') && /Estimated cost/.test(sendDialog?.detail ?? '') && /did not confirm/.test(declinedText) && (await app.evaluate(() => globalThis.__cloudE2E.calls)) === 0, `${JSON.stringify(sendDialog)} ${declinedText}`)
  await answerDialogs([true, true])
  await sortNow()
  await dialog.waitFor({ timeout: 20000 })
  await dialog.locator('button.sorter-cloud-send').click()
  await win.waitForFunction(() => /offline/.test(document.querySelector('.sorter-cloud-result')?.textContent ?? ''), null, { timeout: 60000 })
  const result = win.locator('.sorter-cloud-result')
  await result.waitFor({ timeout: 60000 })
  const offlineText = await result.innerText()
  check('offline run completes with the cloud step skipped', /offline/.test(offlineText), offlineText)
  check('offline: the doubtful ones stay doubtful', ['e2e-doubt-keep', 'e2e-doubt-toss', 'e2e-doubt-unsure'].every((h) => proposal(h).proposal === 'doubtful' && proposal(h).decided_by === null))
  check('offline: the stub got nothing', seen.length === 0)

  // 3. online, through the stub
  await route('stub')
  await sortNow()
  await dialog.waitFor({ timeout: 20000 })
  await dialog.locator('button.sorter-cloud-send').click()
  await win.waitForFunction(() => /Asked Luna about/.test(document.querySelector('.sorter-cloud-result')?.textContent ?? ''), null, { timeout: 60000 })
  const onlineText = await result.innerText()
  check('the run reports what Luna said', /Asked Luna about 3 screenshots: 1 keep, 1 throwaway\. 1 screenshot still needs a look\./.test(onlineText), onlineText)
  const windows = seen.flatMap((s) => s.windows).sort()
  check('only the doubtful screenshots were sent', JSON.stringify(windows) === JSON.stringify(['blurry-chat', 'keep-chart', 'toss-wifi']), JSON.stringify(windows))
  check('each picture was shrunk to 1456 px on its long edge, as JPEG', seen.flatMap((s) => s.dims).every((d) => d.format === 'jpeg' && d.long === 1456), JSON.stringify(seen.map((s) => s.dims)))
  check('the request: Responses API path, gpt-6-luna, JSON schema, store false, Bearer key', seen.every((s) => s.path === '/v1/responses' && s.model === 'gpt-6-luna' && s.format === 'json_schema' && s.store === false && s.auth === `Bearer ${FAKE_KEY}`))
  check("Luna's keep became keep (asked Luna)", JSON.stringify(proposal('e2e-doubt-keep')).includes('"proposal":"keep","decided_by":"luna"'))
  check("Luna's sure throwaway became throwaway (asked Luna)", JSON.stringify(proposal('e2e-doubt-toss')).includes('"proposal":"throwaway","decided_by":"luna"'))
  check("Luna's unsure stays doubtful", proposal('e2e-doubt-unsure').proposal === 'doubtful' && proposal('e2e-doubt-unsure').decided_by === 'luna')
  check('the local proposals were not touched', proposal('e2e-local-keep').reason === 'Looks like screenshots you kept before' && proposal('e2e-local-toss').proposal === 'throwaway')

  // Review: the doubtful card and the confident items name the step
  await closeSettings()
  await win.locator('.view-switch .scope-tab', { hasText: 'Review' }).click()
  await win.waitForSelector('.rv-big', { timeout: 30000 })
  const why = await win.locator('.rv-why').innerText()
  check('the Review card says Luna was asked', why.includes('Luna was not sure either') && why.includes('asked Luna'), why)
  await win.locator('.rv-strip-row').click()
  await win.waitForSelector('.rv-strip-body')
  const strip = await win.locator('.rv-strip-body').innerText()
  check('confident items show which step decided', strip.includes('asked Luna') && strip.includes('by your history'), strip)
  await sleep(300)
  await win.screenshot({ path: join(screens, 'sorter-cloud-review.png') })

  // 4. Haiku as the second provider. Two new doubtful screenshots arrive; of the first three, Luna decided two and was unsure about one.
  const more = [
    { hash: 'e2e-haiku-keep', proposal: 'doubtful', window: 'keep-diagram', colour: '#7b3fb3', takenAt: '2026-10-10T10:00:00' },
    { hash: 'e2e-haiku-unsure', proposal: 'doubtful', window: 'blurry-page', colour: '#b36d3f', takenAt: '2026-10-10T09:00:00' }
  ]
  {
    for (const s of more) {
      const f = join(source, nameOf(s))
      await sharp({ create: { width: 3024, height: 1964, channels: 3, background: s.colour } }).png().toFile(f)
      realHash.set(s.hash, createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 12))
    }
    const t = new DatabaseSync(join(well, 'triage.db'))
    t.exec('PRAGMA busy_timeout=5000;')
    const fts = t.prepare("INSERT INTO triage_fts (hash, kind, rel_path, filename, ext, size, mtime, offline, ocr_text, source, taken_at, app, window_title) VALUES (?, 'image', ?, ?, 'png', ?, ?, '0', '', ?, ?, 'Test App', ?)")
    const prop = t.prepare("INSERT INTO sorter_proposals (hash, proposal, confidence, p_keep, reason, rule, sorter_version, model_id, proposed_at) VALUES (?, 'doubtful', 0.6, 0.4, ?, NULL, ?, NULL, ?)")
    for (const s of more) {
      const st = statSync(join(source, nameOf(s)))
      fts.run(realHash.get(s.hash), nameOf(s), nameOf(s), String(st.size), String(Math.round(st.mtimeMs)), source, s.takenAt, s.window)
      prop.run(realHash.get(s.hash), `Not sure: local reason for ${s.window}`, SORTER_VERSION, new Date().toISOString())
    }
    t.close()
  }
  await gotoSorter()
  const readCfg = () => JSON.parse(readFileSync(join(userData, 'config.json'), 'utf8')).sorterCloud ?? {}
  const lunaCalls = seen.length
  const shownBefore = (await dialogsShown()).length
  await answerDialogs([false, true])
  await section.locator('input.sorter-cloud-provider-anthropic').click() // declined in main's dialog
  for (let i = 0; i < 50 && (await dialogsShown()).length < shownBefore + 1; i++) await sleep(100)
  await sleep(300)
  const switchDialog = (await dialogsShown()).at(-1)
  check('choosing Haiku while asking is on raises main’s own dialog, naming Anthropic and what it receives', Boolean(switchDialog?.parent) && /Ask Haiku instead of Luna\?/.test(switchDialog?.message ?? '') && /Anthropic \(claude-haiku-5-5\) receives the picture/.test(switchDialog?.detail ?? '') && /app name and window title/.test(switchDialog?.detail ?? '') && /Estimated cost at list price/.test(switchDialog?.detail ?? '') && /free monthly Anthropic API credits/.test(switchDialog?.detail ?? ''), JSON.stringify(switchDialog))
  check('that dialog counts the one Luna was unsure about as its own number', /3 doubtful screenshots are waiting now, 1 of them one Luna was unsure about; 3 screenshots would go at the next sort\./.test(switchDialog?.detail ?? ''), switchDialog?.detail)
  const afterDecline = await win.evaluate(() => window.sw.cloud.status())
  check('declined: Luna is still the provider, still on, and Anthropic has no opt-in', afterDecline.settings.provider === 'openai' && afterDecline.settings.enabled === true && !readCfg().anthropicOptedInAt && (await section.locator('input.sorter-cloud-provider-openai').isChecked()), JSON.stringify(afterDecline.settings))
  await section.locator('input.sorter-cloud-provider-anthropic').click() // confirmed
  await win.waitForFunction(async () => (await window.sw.cloud.status()).settings.provider === 'anthropic')
  const cfgSwitched = readCfg()
  check('confirmed: Haiku is the provider and Anthropic’s own opt-in is recorded beside OpenAI’s', cfgSwitched.provider === 'anthropic' && Number.isFinite(Date.parse(cfgSwitched.anthropicOptedInAt)) && cfgSwitched.optedInAt === optedIn, JSON.stringify({ ...cfgSwitched, keyEnc: undefined, lastRun: undefined }))
  const noKeyPrep = await win.evaluate(() => window.sw.cloud.prepare())
  check('Haiku without an Anthropic key sends nothing, though an OpenAI key is saved', noKeyPrep.blocked === 'no-key' && noKeyPrep.token === null && noKeyPrep.provider === 'anthropic', JSON.stringify(noKeyPrep))
  const antForm = await openKeyForm('sorting.anthropicKey')
  await antForm.input.fill(FAKE_KEY) // the OpenAI-shaped key, in the wrong field
  await antForm.row.getByRole('button', { name: 'Add key', exact: true }).click()
  await antForm.sw.locator('[role="alert"]').waitFor({ timeout: 10000 }) // the window's notice (main's exact words are not shown any more)
  check('an OpenAI-shaped key is refused as the Anthropic key', !readCfg().anthropicKeyEnc && (await antForm.row.getByText(/Key saved/).count()) === 0)
  await antForm.input.fill(FAKE_ANT_KEY)
  await antForm.row.getByRole('button', { name: 'Add key', exact: true }).click()
  await antForm.row.getByText(/Key saved/).waitFor({ timeout: 10000 })
  await gotoSorter()
  await anthropicRow.locator('.pic-ready', { hasText: 'Saved' }).waitFor({ timeout: 10000 })
  const cfgBothText = readFileSync(join(userData, 'config.json'), 'utf8')
  const cfgBoth = readCfg()
  check('each provider’s key is held as its own ciphertext; the OpenAI key is still there', !cfgBothText.includes('E2EANTLEAKCHECK') && !cfgBothText.includes('E2ELEAKCHECK') && typeof cfgBoth.anthropicKeyEnc === 'string' && cfgBoth.anthropicKeyEnc.length > 20 && cfgBoth.keyEnc === cfg.sorterCloud.keyEnc && cfgBoth.anthropicKeyEnc !== cfgBoth.keyEnc)
  const stBoth = await win.evaluate(() => window.sw.cloud.status())
  check('status says both keys are saved and carries neither', stBoth.providers.every((p) => p.hasKey) && !/sk-|LEAKCHECK/.test(JSON.stringify(stBoth)), JSON.stringify(stBoth.providers))
  await section.screenshot({ path: join(screens, 'sorter-cloud-settings-haiku.png') })
  await sortNow()
  await dialog.waitFor({ timeout: 20000 })
  const haikuText = await dialog.innerText()
  check('Sort now with Haiku: count, list-price estimate, the free-credits line and the company', /Ask Haiku about 3 screenshots, 1 of them one Luna was unsure about\?/.test(haikuText) && /Estimated cost at list price: (about \$|under \$)/.test(haikuText) && /free monthly Anthropic API credits/.test(haikuText) && /sent to Anthropic \(claude-haiku-5-5\)/.test(haikuText) && !/OpenAI/.test(haikuText), haikuText)
  check('the confirm box gives the second opinion as its own number', /3 screenshots the sorter could not call, 1 of them one Luna was unsure about, will be sent to Anthropic \(claude-haiku-5-5\) in 1 request\./.test(haikuText.replace(/\s+/g, ' ')), haikuText)
  await win.screenshot({ path: join(screens, 'sorter-cloud-confirm-haiku.png') })
  await answerDialogs([true])
  await dialog.locator('button.sorter-cloud-send').click()
  await win.waitForFunction(() => /Asked Haiku about/.test(document.querySelector('.sorter-cloud-result')?.textContent ?? ''), null, { timeout: 60000 })
  const haikuResult = await result.innerText()
  const haikuSend = (await dialogsShown()).at(-1)
  check('main’s send dialog names Haiku and Anthropic', /Send 3 screenshots to Haiku\?/.test(haikuSend?.message ?? '') && /^3 screenshots the sorter could not call, 1 of them one Luna was unsure about, will go to Anthropic in 1 request\./.test(haikuSend?.detail ?? '') && !/OpenAI/.test(haikuSend?.detail ?? ''), JSON.stringify(haikuSend))
  check('the run reports what Haiku said', /Asked Haiku about 3 screenshots: 1 keep, 0 throwaway\. 2 screenshots still need a look\./.test(haikuResult), haikuResult)
  check('the two new doubtful screenshots and the one Luna was unsure about went to Anthropic, not the two Luna decided; nothing more went to OpenAI', JSON.stringify(seenHaiku.flatMap((s) => s.windows).sort()) === JSON.stringify(['blurry-chat', 'blurry-page', 'keep-diagram']) && seen.length === lunaCalls, JSON.stringify(seenHaiku.map((s) => s.windows)))
  check('the request: Messages API path, claude-haiku-5-5, forced answer tool, x-api-key and version headers, no Bearer token', seenHaiku.length === 1 && seenHaiku.every((s) => s.path === '/v1/messages' && s.model === 'claude-haiku-5-5' && s.toolChoice?.type === 'tool' && s.toolChoice?.name === s.tool && s.apiKey === FAKE_ANT_KEY && s.version === '2023-06-01' && s.auth === undefined && s.maxTokens >= 512), JSON.stringify(seenHaiku.map((s) => ({ ...s, apiKey: s.apiKey === FAKE_ANT_KEY }))))
  check('each picture went as a base64 JPEG block, shrunk to 1456 px on its long edge', seenHaiku.flatMap((s) => s.dims).length === 3 && seenHaiku.flatMap((s) => s.dims).every((d) => d.format === 'jpeg' && d.long === 1456 && d.declared === 'base64:image/jpeg'), JSON.stringify(seenHaiku.map((s) => s.dims)))
  const hk = proposal('e2e-haiku-keep')
  const hu = proposal('e2e-haiku-unsure')
  check("Haiku's keep became keep, recorded as haiku with its model", hk.proposal === 'keep' && hk.decided_by === 'haiku' && hk.decided_model === 'claude-haiku-5-5', JSON.stringify(hk))
  check("Haiku's unsure stays doubtful, in Haiku's name", hu.proposal === 'doubtful' && hu.decided_by === 'haiku' && /Haiku was not sure either/.test(hu.reason), JSON.stringify(hu))
  const second = proposal('e2e-doubt-unsure')
  check('the one both were unsure about still waits in Review, with Haiku’s words', second.proposal === 'doubtful' && second.decided_by === 'haiku' && /Haiku was not sure either/.test(second.reason), JSON.stringify(second))
  const both = answerRows(`hash = '${realHash.get('e2e-doubt-unsure')}'`).rows
  check('its answers are kept per provider: Luna’s row beside Haiku’s', JSON.stringify(both.map((r) => [r.provider, r.model, r.verdict])) === JSON.stringify([['anthropic', 'claude-haiku-5-5', 'unsure'], ['openai', 'gpt-6-luna', 'unsure']]), JSON.stringify(both))
  check("Luna's earlier decisions are untouched", proposal('e2e-doubt-keep').decided_by === 'luna' && proposal('e2e-doubt-keep').decided_model === 'gpt-6-luna' && proposal('e2e-doubt-toss').proposal === 'throwaway' && proposal('e2e-local-keep').decided_model === null, JSON.stringify(proposal('e2e-doubt-keep')))
  const hosts = await app.evaluate(() => globalThis.__cloudE2E.hosts ?? [])
  check('the Haiku run called api.anthropic.com only', hosts.at(-1) === 'api.anthropic.com' && hosts.filter((h) => h === 'api.anthropic.com').length === 1, JSON.stringify(hosts))
  await closeSettings()
  // Review was open behind Settings and still shows what it loaded before the Haiku run: leave and come back
  await win.locator('.view-switch .scope-tab', { hasText: 'Search' }).click()
  await win.locator('.view-switch .scope-tab', { hasText: 'Review' }).click()
  await win.waitForSelector('.rv-big', { timeout: 30000 })
  await win.waitForFunction(() => /5 sorted confidently/.test(document.body.innerText), null, { timeout: 30000 })
  if (!(await win.locator('.rv-strip-body').count())) await win.locator('.rv-strip-row').click()
  await win.waitForSelector('.rv-strip-body')
  const stripHaiku = await win.locator('.rv-strip-body').innerText()
  check('Review names Haiku where Haiku was asked, beside Luna’s', stripHaiku.includes('asked Haiku') && stripHaiku.includes('asked Luna'), stripHaiku)
  await sleep(300)
  await win.screenshot({ path: join(screens, 'sorter-cloud-review-haiku.png') })

  // 5. back with Luna (already agreed to, so no dialog): the one Haiku was unsure about goes, once
  const dialogsBefore = (await dialogsShown()).length
  await win.evaluate(() => window.sw.cloud.setSettings({ provider: 'openai' }))
  const backPrep = await win.evaluate(() => window.sw.cloud.prepare())
  check('back with Luna: only the one Haiku was unsure about is offered, as a second opinion', backPrep.provider === 'openai' && backPrep.blocked === null && backPrep.toSend === 1 && backPrep.secondOpinions === 1 && backPrep.message === 'Ask Luna about 1 screenshot, one Haiku was unsure about?', JSON.stringify(backPrep))
  await answerDialogs([true])
  const backRun = await win.evaluate((token) => window.sw.cloud.send(token), backPrep.token)
  check('it went to OpenAI and nothing else did', backRun.asked === 1 && seen.length === lunaCalls + 1 && JSON.stringify(seen.at(-1).windows) === JSON.stringify(['blurry-page']) && seenHaiku.length === 1, JSON.stringify(backRun))
  const stubCalls = seen.length + seenHaiku.length
  let quiet = true
  for (const provider of ['openai', 'anthropic', 'openai', 'anthropic']) {
    await win.evaluate((provider) => window.sw.cloud.setSettings({ provider }), provider)
    const p = await win.evaluate(() => window.sw.cloud.prepare())
    if (p.provider !== provider || p.blocked !== 'nothing-doubtful' || p.toSend !== 0 || p.token !== null) quiet = false
  }
  check('once both have answered, neither is offered anything, whichever is selected', quiet && seen.length + seenHaiku.length === stubCalls && (await dialogsShown()).length === dialogsBefore + 1)
  const table = answerRows()
  check('the answers table was migrated to one row per screenshot and provider', JSON.stringify(table.columns.filter((c) => c.pk).map((c) => c.name)) === JSON.stringify(['hash', 'provider']), JSON.stringify(table.columns))
  const carried = table.rows.find((r) => r.hash === 'e2e-old-answer')
  check('the row stored before the upgrade survived, attributed to OpenAI', carried?.provider === 'openai' && carried?.verdict === 'unsure' && carried?.reason === 'An earlier answer' && carried?.model === 'gpt-6-luna' && carried?.asked_at === '2026-10-08T02:00:00.000Z', JSON.stringify(carried))
  check('no screenshot has more than one answer per provider or more than two in all', Object.values(Object.groupBy(table.rows, (r) => r.hash)).every((rs) => rs.length <= 2 && new Set(rs.map((r) => r.provider)).size === rs.length), JSON.stringify(table.rows.map((r) => [r.hash, r.provider])))

  // 5b. the period (one setting for both sort buttons): two more doubtful screenshots, one taken two days ago and one over a year ago
  const p2 = (x) => String(x).padStart(2, '0')
  const localTime = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  const periodShots = [
    { hash: 'e2e-period-recent', proposal: 'doubtful', window: 'keep-period-recent', colour: '#7b4fa3', takenAt: localTime(new Date(Date.now() - 2 * 86400e3)) },
    { hash: 'e2e-period-old', proposal: 'doubtful', window: 'keep-period-old', colour: '#a34f4f', takenAt: localTime(new Date(Date.now() - 400 * 86400e3)) }
  ]
  {
    const t = new DatabaseSync(join(well, 'triage.db'))
    const fts = t.prepare("INSERT INTO triage_fts (hash, kind, rel_path, filename, ext, size, mtime, offline, ocr_text, source, taken_at, app, window_title) VALUES (?, 'image', ?, ?, 'png', ?, ?, '0', '', ?, ?, 'Test App', ?)")
    const prop = t.prepare("INSERT INTO sorter_proposals (hash, proposal, confidence, p_keep, reason, rule, sorter_version, model_id, proposed_at) VALUES (?, 'doubtful', 0.6, 0.4, ?, NULL, ?, NULL, ?)")
    for (const s of periodShots) {
      const f = join(source, nameOf(s))
      await sharp({ create: { width: 3024, height: 1964, channels: 3, background: s.colour } }).png().toFile(f)
      realHash.set(s.hash, createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 12))
      const st = statSync(f)
      fts.run(realHash.get(s.hash), nameOf(s), nameOf(s), String(st.size), String(Math.round(st.mtimeMs)), source, s.takenAt, s.window)
      prop.run(realHash.get(s.hash), `Not sure: local reason for ${s.window}`, SORTER_VERSION, new Date().toISOString())
    }
    t.close()
  }
  // the period is a shared setting now (sorting.period in settings.json); unset while it is the default
  const storedPeriod = () => JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).settings?.['sorting.period']
  await win.evaluate(() => window.sw.cloud.setSettings({ provider: 'openai' }))
  const everything = await win.evaluate(() => window.sw.cloud.prepare())
  check('with no period chosen, Sort now takes everything, as before', everything.period === 'all' && everything.toSend === 2 && everything.message === 'Ask Luna about 2 screenshots?' && storedPeriod() === undefined, JSON.stringify(everything))
  const refusedPeriod = []
  for (const bad of ['everything', '365d', '', null, { period: 'all' }, '1970-01-01T00:00:00']) refusedPeriod.push(await win.evaluate((bad) => window.sw.sorter.setPeriod(bad), bad))
  check('main refuses a period that is not one of the four and stores nothing', refusedPeriod.every((r) => r.ok === false && r.period === 'all') && storedPeriod() === undefined, JSON.stringify(refusedPeriod))

  await openAuto()
  const selects = win.locator('select.sorter-period-select')
  const optionTexts = await selects.first().locator('option').allInnerTexts()
  check('one period choice sits beside Sort now: Last 7 days, Last 30 days, Last 90 days, Everything (the default)', (await selects.count()) === 1 && JSON.stringify(optionTexts) === JSON.stringify(['Last 7 days', 'Last 30 days', 'Last 90 days', 'Everything']) && (await selects.nth(0).inputValue()) === 'all', JSON.stringify(optionTexts))
  check('the tab says the nightly sort takes everything', /The nightly sort takes everything\./.test(await win.locator('.as-sort').innerText()), await win.locator('.as-sort').innerText())
  await selects.first().selectOption('7d')
  await win.waitForFunction(async () => (await window.sw.cloud.status()).period === '7d')
  await sleep(300)
  check('choosing Last 7 days is stored in settings.json', storedPeriod() === '7d' && (await selects.nth(0).inputValue()) === '7d' && (await win.evaluate(() => window.sw.sorter.status())).period === '7d', String(storedPeriod()))
  check('the batch prepared under Everything can no longer be sent', (await win.evaluate((token) => window.sw.cloud.send(token), everything.token)).skipped === 'not-prepared' && seen.length + seenHaiku.length === stubCalls)
  await win.locator('.as-sort').screenshot({ path: join(screens, 'sorter-period-sort-now.png') })

  const periodDialogs = (await dialogsShown()).length
  await sortNow()
  await dialog.waitFor({ timeout: 20000 })
  const periodText = (await dialog.innerText()).replace(/\s+/g, ' ')
  check('under Last 7 days the confirm box gives the period in its heading and its period sentence, and the count line does not repeat it', /Last 7 days: ask Luna about 1 screenshot\?/.test(periodText) && / 1 screenshot the sorter could not call will be sent to OpenAI \(gpt-6-luna\) in 1 request\./.test(periodText) && !/Last 7 days: 1 screenshot the sorter/.test(periodText) && (periodText.match(/Last 7 days/g) ?? []).length === 1 && /Period: the last 7 days, by the date in each file name\. Screenshots taken before that, or with no date in their name, are not sorted or sent and stay as they are\./.test(periodText), periodText)
  await win.screenshot({ path: join(screens, 'sorter-period-confirm.png') })
  await answerDialogs([true])
  await dialog.locator('button.sorter-cloud-send').click()
  await win.waitForFunction(() => /Asked Luna about 1 screenshot from the last 7 days/.test(document.querySelector('.sorter-cloud-result')?.textContent ?? ''), null, { timeout: 60000 })
  const periodSend = (await dialogsShown()).at(-1)
  check('main’s own dialog names the period and counts only it', (await dialogsShown()).length === periodDialogs + 1 && periodSend?.message === 'Send 1 screenshot from the last 7 days to Luna?' && /^Last 7 days: 1 screenshot the sorter could not call will go to OpenAI in 1 request\./.test(periodSend?.detail ?? '') && /Period: the last 7 days/.test(periodSend?.detail ?? ''), JSON.stringify(periodSend))
  check('only the screenshot from the last 7 days went to the stub', seen.length + seenHaiku.length === stubCalls + 1 && JSON.stringify(seen.at(-1).windows) === JSON.stringify(['keep-period-recent']) && proposal('e2e-period-recent').proposal === 'keep', JSON.stringify(seen.at(-1)?.windows))
  check('the older one is untouched: still doubtful, never asked about', proposal('e2e-period-old').proposal === 'doubtful' && proposal('e2e-period-old').decided_by === null && answerRows(`hash = '${realHash.get('e2e-period-old')}'`).rows.length === 0)
  const nothingIn7 = await win.evaluate(() => window.sw.cloud.prepare())
  check('nothing more is offered under Last 7 days, though an older one waits', nothingIn7.blocked === 'nothing-doubtful' && nothingIn7.token === null && nothingIn7.message === 'Nothing doubtful from the last 7 days is waiting for Luna.', JSON.stringify(nothingIn7))

  // prepared under Everything, then the period is changed before the send: nothing goes
  await win.evaluate(() => window.sw.sorter.setPeriod('all'))
  const wide = await win.evaluate(() => window.sw.cloud.prepare())
  const narrowed = await win.evaluate(() => window.sw.sorter.setPeriod('90d'))
  const afterChange = await win.evaluate((token) => window.sw.cloud.send(token), wide.token)
  check('a period change between the preview and the send invalidates the batch: nothing is sent', wide.toSend === 1 && wide.period === 'all' && narrowed.ok === true && afterChange.skipped === 'not-prepared' && afterChange.asked === 0 && seen.length + seenHaiku.length === stubCalls + 1 && (await dialogsShown()).length === periodDialogs + 1 && proposal('e2e-period-old').proposal === 'doubtful', JSON.stringify({ wide, afterChange }))
  const in90 = await win.evaluate(() => window.sw.cloud.prepare())
  check('Last 90 days does not reach it either', in90.period === '90d' && in90.blocked === 'nothing-doubtful' && in90.message === 'Nothing doubtful from the last 90 days is waiting for Luna.', JSON.stringify(in90))
} catch (e) {
  failed++
  console.log(`FAIL  ${e?.stack ?? e}`)
} finally {
  await app.close().catch(() => undefined)
  server.close()
}

// 6. leakage: config.json, the app's output, every file in the profile
const logs = output.join('')
check('the app log has no key of either provider', !logs.includes(FAKE_KEY) && !logs.includes(FAKE_ANT_KEY) && !logs.includes('LEAKCHECK') && !/sk-ant|sk-test/.test(logs))
check('the app log names the Haiku run', /\[sorter-cloud\] manual run \(Haiku\)/.test(logs), logs.slice(0, 400))
check('the app log names the runs (so the leak check had something to read)', /\[sorter-cloud\] manual run/.test(logs), logs.slice(0, 400))
const hits = []
const walk = (d) => {
  for (const f of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, f.name)
    if (f.isDirectory()) walk(p)
    else if (f.isFile() && statSync(p).size < 50_000_000 && (readFileSync(p).includes(Buffer.from('E2ELEAKCHECK')) || readFileSync(p).includes(Buffer.from('E2EANTLEAKCHECK')))) hits.push(p.slice(userData.length + 1))
  }
}
if (existsSync(userData)) walk(userData)
check('no file in the profile holds either key in plain text', hits.length === 0, hits.join(', '))
console.log(`screens: ${screens}`)
console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
process.exit(failed ? 1 : 0)
