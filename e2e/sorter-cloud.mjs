// End-to-end: the sorter's cloud step (ticket 07) in the real app, hidden, against a local stub of
// the OpenAI Responses API. Synthetic data only: a scratch well whose triage.db holds five generated
// screenshots with sorter proposals (three doubtful, one keep, one throwaway).
//
//   1. Settings › Ask Luna: save a made-up key; config.json holds only ciphertext.
//   2. Sort now while "offline" (every https request fails): the confirm dialog shows count + cost;
//      after Send the run completes with the cloud step skipped and the items stay doubtful.
//   3. Sort now online: only the three doubtful screenshots reach the stub, shrunk to ≤ 1456 px; the
//      answers are recorded under the keep-bias with decided_by 'luna'; Review shows "asked Luna".
//   4. The made-up key appears nowhere in config.json, the app's stdout/stderr or the profile folder.
//
// Run after `npm run build` (or `npx electron-vite build`):  node e2e/sorter-cloud.mjs
// Optional: SLIDEWELL_CLOUD_SCRATCH (default ~/Library/Caches/slidewell-e2e-sorter-cloud),
//   SLIDEWELL_CLOUD_SCREENS (where screenshots go; default <scratch>/screens).
//
// Isolation: own --user-data-dir, own HOME, --use-mock-keychain (safeStorage works without touching
// the login keychain), SLIDEWELL_E2E_HIDDEN=1. The stub is reached through a test-only https
// interception installed from this script in the main process (protocol.handle); the app's own code
// has no stub switch. Nothing goes to the real network.
import { _electron as electron } from 'playwright'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import sharp from 'sharp'

const repo = resolve(import.meta.dirname, '..')
const scratch = resolve(process.env.SLIDEWELL_CLOUD_SCRATCH || join(homedir(), 'Library', 'Caches', 'slidewell-e2e-sorter-cloud'))
const screens = resolve(process.env.SLIDEWELL_CLOUD_SCREENS || join(scratch, 'screens'))
const FAKE_KEY = 'sk-test-E2ELEAKCHECK-0123456789abcdefghijklmnopqrstuv'
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
for (const s of shots) await sharp({ create: { width: 3024, height: 1964, channels: 3, background: s.colour } }).png().toFile(join(source, `${s.hash}.png`))
{
  const t = new DatabaseSync(join(well, 'triage.db'))
  t.exec(`CREATE VIRTUAL TABLE triage_fts USING fts5(hash UNINDEXED, kind UNINDEXED, rel_path UNINDEXED, filename, ext UNINDEXED, size UNINDEXED, mtime UNINDEXED,
            poster_rel UNINDEXED, offline UNINDEXED, ocr_text, scanned_at UNINDEXED, source UNINDEXED, taken_at UNINDEXED, app, window_title);
          CREATE TABLE triage_decisions (hash TEXT PRIMARY KEY, state TEXT NOT NULL, decided_at TEXT, well_id TEXT);
          CREATE TABLE sorter_proposals (hash TEXT PRIMARY KEY, proposal TEXT NOT NULL, confidence REAL NOT NULL, p_keep REAL NOT NULL, reason TEXT NOT NULL, rule TEXT,
            sorter_version TEXT NOT NULL, model_id TEXT, proposed_at TEXT NOT NULL, throwaway_since TEXT, answered_at TEXT, answer TEXT, decided_by TEXT);`)
  const fts = t.prepare("INSERT INTO triage_fts (hash, kind, rel_path, filename, ext, size, mtime, offline, ocr_text, source, taken_at, app, window_title) VALUES (?, 'image', ?, ?, 'png', ?, ?, '0', '', ?, ?, 'Test App', ?)")
  const prop = t.prepare('INSERT INTO sorter_proposals (hash, proposal, confidence, p_keep, reason, rule, sorter_version, model_id, proposed_at, throwaway_since, decided_by) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?)')
  const now = new Date().toISOString()
  for (const s of shots) {
    const f = join(source, `${s.hash}.png`)
    const st = statSync(f)
    fts.run(s.hash, `${s.hash}.png`, `${s.hash}.png`, String(st.size), String(Math.round(st.mtimeMs)), source, s.takenAt, s.window)
    const local = s.proposal === 'doubtful' ? null : 'history'
    prop.run(s.hash, s.proposal, 0.6, s.proposal === 'keep' ? 0.9 : 0.4, s.proposal === 'doubtful' ? `Not sure: local reason for ${s.window}` : 'Looks like screenshots you kept before', SORTER_VERSION, now, s.proposal === 'throwaway' ? now : null, local)
  }
  t.close()
}
writeFileSync(
  join(userData, 'config.json'),
  JSON.stringify({ archiveRoot: join(scratch, 'no-archive'), wellRoot: well, othersArchiveRoot: join(scratch, 'others'), vaultRoot: join(scratch, 'no-vault'), pictureSearch: { paused: true, includeWell: false }, sorterCloud: { since: new Date().toISOString() } }, null, 2),
  'utf8'
)
const proposal = (hash) => {
  const db = new DatabaseSync(join(well, 'triage.db'), { readOnly: true })
  try {
    return db.prepare('SELECT proposal, decided_by, reason FROM sorter_proposals WHERE hash = ?').get(hash)
  } finally {
    db.close()
  }
}

// --- the stub: answers like Luna by the window title sent beside each picture ---
const seen = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', async () => {
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
// test-only https interception: 'offline' fails every request; 'stub' forwards api.openai.com to the stub
const route = (mode) =>
  app.evaluate(async ({ protocol, net }, { mode, stubUrl }) => {
    globalThis.__cloudE2E = globalThis.__cloudE2E ?? { calls: 0 }
    if (protocol.isProtocolHandled('https')) protocol.unhandle('https')
    protocol.handle('https', async (req) => {
      globalThis.__cloudE2E.calls++
      const u = new URL(req.url)
      if (mode === 'offline' || u.host !== 'api.openai.com') throw new Error('offline (e2e)')
      const headers = {}
      req.headers.forEach((v, k) => (headers[k] = v))
      return net.fetch(`${stubUrl}${u.pathname}`, { method: req.method, headers, body: await req.text() })
    })
  }, { mode, stubUrl })

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

  // 1. the key
  await win.locator('button.tb-btn[title^="Settings"]').click()
  const section = win.locator('.sorter-cloud')
  await section.waitFor()
  await section.scrollIntoViewIfNeeded()
  check('Settings shows the Luna section with no key yet', (await section.locator('.sorter-cloud-key-input').count()) === 1)
  await section.screenshot({ path: join(screens, 'sorter-cloud-settings-no-key.png') })
  await section.locator('.sorter-cloud-key-input').fill(FAKE_KEY)
  await section.locator('button', { hasText: 'Save key' }).click()
  await section.locator('.pic-ready', { hasText: 'Saved' }).waitFor({ timeout: 10000 })
  const st = await win.evaluate(() => window.sw.cloud.status())
  check('status says a key is saved (and carries no key)', st.hasKey === true && !JSON.stringify(st).includes(FAKE_KEY))
  const cfgText = readFileSync(join(userData, 'config.json'), 'utf8')
  const cfg = JSON.parse(cfgText)
  check('config.json holds the key only as ciphertext', !cfgText.includes(FAKE_KEY) && !cfgText.includes('E2ELEAKCHECK') && typeof cfg.sorterCloud?.keyEnc === 'string' && cfg.sorterCloud.keyEnc.length > 20)
  await section.screenshot({ path: join(screens, 'sorter-cloud-settings.png') })

  // 2. offline
  await section.locator('button.sorter-cloud-sort').click()
  const dialog = win.locator('.sorter-cloud-confirm')
  await dialog.waitFor({ timeout: 20000 })
  const dialogText = await dialog.innerText()
  check('Sort now asks first: count and estimated cost', /Ask Luna about 3 screenshots\?/.test(dialogText) && /Estimated cost: (about \$|under \$)/.test(dialogText), dialogText)
  await win.screenshot({ path: join(screens, 'sorter-cloud-confirm.png') })
  check('nothing was sent before the click', seen.length === 0 && (await app.evaluate(() => globalThis.__cloudE2E.calls)) === 0)
  await dialog.locator('button.sorter-cloud-send').click()
  const result = section.locator('.sorter-cloud-result')
  await result.waitFor({ timeout: 60000 })
  const offlineText = await result.innerText()
  check('offline run completes with the cloud step skipped', /offline/.test(offlineText), offlineText)
  check('offline: the doubtful ones stay doubtful', ['e2e-doubt-keep', 'e2e-doubt-toss', 'e2e-doubt-unsure'].every((h) => proposal(h).proposal === 'doubtful' && proposal(h).decided_by === null))
  check('offline: the stub got nothing', seen.length === 0)

  // 3. online, through the stub
  await route('stub')
  await section.locator('button.sorter-cloud-sort').click()
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
  await win.locator('.settings-modal .modal-head button', { hasText: 'close' }).click()
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
} catch (e) {
  failed++
  console.log(`FAIL  ${e?.stack ?? e}`)
} finally {
  await app.close().catch(() => undefined)
  server.close()
}

// 4. leakage: config.json, the app's output, every file in the profile
const logs = output.join('')
check('the app log has no key', !logs.includes(FAKE_KEY) && !logs.includes('E2ELEAKCHECK'))
check('the app log names the runs (so the leak check had something to read)', /\[sorter-cloud\] manual run/.test(logs), logs.slice(0, 400))
const hits = []
const walk = (d) => {
  for (const f of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, f.name)
    if (f.isDirectory()) walk(p)
    else if (f.isFile() && statSync(p).size < 50_000_000 && readFileSync(p).includes(Buffer.from('E2ELEAKCHECK'))) hits.push(p.slice(userData.length + 1))
  }
}
if (existsSync(userData)) walk(userData)
check('no file in the profile holds the key in plain text', hits.length === 0, hits.join(', '))
console.log(`screens: ${screens}`)
console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
process.exit(failed ? 1 : 0)
