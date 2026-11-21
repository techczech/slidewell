// Shared settings end to end, on a throwaway --user-data-dir and HOME (never the real data): the first launch
// moves config.json's preferences into settings.json (config.json left as it was, entries "app update"),
// the gear opens the one Settings window, the menu bar is generated with Settings… ⌘, the cheat sheet lists
// every command (None when unbound), and a change made by the settings CLI shows in the open window. The
// Settings window's custom pages still reach the app's own IPC (judged by frame), and a Triage folder set
// by the CLI is watched at once (a screenshot dropped there is picked up without a Scan).
// Needs no archive. Run: npm run test:settings (builds first).
import { _electron as electron } from 'playwright'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const out = (o) => console.log(JSON.stringify(o))
const work = mkdtempSync(join(tmpdir(), 'sw-settings-e2e-'))
const userData = join(work, 'userData')
const home = join(work, 'home')
mkdirSync(userData, { recursive: true })
mkdirSync(home, { recursive: true })
const config = {
  wellRoot: join(work, 'well'),
  othersArchiveRoot: join(work, 'others-library'),
  convertOcrByDefault: true,
  r2: { accountId: 'acc-e2e', accessKeyIdEnc: 'not-a-real-ciphertext' },
  windowBounds: { width: 1300, height: 860 }
}
writeFileSync(join(userData, 'config.json'), JSON.stringify(config), 'utf8')
process.on('exit', () => rmSync(work, { recursive: true, force: true }))
const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const env = { ...process.env, HOME: home, SLIDEWELL_E2E_HIDDEN: '1' }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env })
const r = {}
try {
  const win = await app.firstWindow({ timeout: 20000 })
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(1500)

  const settingsFile = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))
  const cfg = JSON.parse(readFileSync(join(userData, 'config.json'), 'utf8'))
  r.migrated = settingsFile.settings['library.wellRoot'] === config.wellRoot && settingsFile.settings['library.convertOcr'] === true && settingsFile.settings['storage.r2AccountId'] === 'acc-e2e'
  r.appUpdateEntries = settingsFile.changes.length === 4 && settingsFile.changes.every((e) => e.who.kind === 'app-update' && e.who.version === version)
  r.configUntouched = JSON.stringify(cfg) === JSON.stringify(config) // the old version's file stays as it was
  r.stamped = existsSync(join(userData, 'settings-migration.json'))
  r.noKeyInSettings = !JSON.stringify(settingsFile).includes('not-a-real-ciphertext')

  const menu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((m) => ({ label: m.label, items: m.submenu?.items.map((i) => ({ label: i.label, accel: i.accelerator ?? null })) ?? [] })) ?? [])
  const appMenu = menu[0]?.items ?? []
  r.menuFrame = menu.map((m) => m.label).join(' | ')
  r.menuSettings = appMenu.some((i) => i.label.startsWith('Settings') && i.accel) && appMenu.some((i) => i.label.startsWith('Export Settings')) && appMenu.some((i) => i.label.startsWith('Import Settings'))

  await win.keyboard.press('Escape') // leave the search field
  await win.waitForTimeout(150)
  await win.keyboard.press('?')
  await win.waitForTimeout(300)
  const rows = await win.locator('.help-modal .drow[data-command]').count()
  const none = await win.locator('.help-modal .help-none').count()
  r.cheatSheet = rows >= 30 && none >= 3
  r.cheatRows = rows
  await win.keyboard.press('Escape')
  await win.waitForTimeout(200)

  const [settingsWin] = await Promise.all([app.waitForEvent('window', { timeout: 10000 }), win.locator('.titlebar-actions .tb-btn', { hasText: '⚙' }).click()])
  settingsWin.on('console', (m) => console.error('[settings console]', m.text()))
  settingsWin.on('pageerror', (e) => console.error('[settings error]', e.message))
  await settingsWin.waitForSelector('.bsw-root', { timeout: 10000 })
  r.ownWindow = settingsWin.url().endsWith('settings.html')
  await win.locator('.titlebar-actions .tb-btn', { hasText: '⚙' }).click()
  await win.waitForTimeout(300)
  r.singleInstance = app.windows().filter((w) => w.url().endsWith('settings.html')).length === 1
  r.customPages = (await settingsWin.locator('[data-section="requirements"]').count()) === 1 && (await settingsWin.locator('[data-section="sorter-service"]').count()) === 1
  await settingsWin.locator('[data-section="accounts"]').click()
  await settingsWin.waitForTimeout(300)
  const accounts = await settingsWin.locator('.bsw-root').innerText()
  r.slots = accounts.includes('R2 access key ID') && accounts.includes('OpenAI key') && !accounts.includes('not-a-real-ciphertext')
  await settingsWin.screenshot({ path: join(tmpdir(), 'sw-settings-accounts.png') }).catch(() => {})

  // the agent path writes through the same store; the open window shows it within a second
  await settingsWin.locator('[data-section="sorting"]').click()
  execFileSync('bun', ['bin/slidewell.mjs', 'settings', 'set', 'sorting.period', '30d', '--agent', 'e2e'], { env: { ...process.env, SLIDEWELL_DATA_DIR: userData } })
  await settingsWin.waitForTimeout(1200)
  r.liveFromCli = (await settingsWin.locator('.bsw-root').innerText()).includes('Last 30 days')
  await settingsWin.screenshot({ path: join(tmpdir(), 'sw-settings-sorting.png') }).catch(() => {})

  // the app's own IPC answers the Settings window's page (top frame, its own page)
  r.customIpcFromSettings = await settingsWin.evaluate(() => window.sw.picture.status().then(() => true, () => false))

  // the Triage folder set from the CLI: the watcher follows it (no Scan pressed)
  const shots = join(work, 'shots')
  mkdirSync(shots, { recursive: true })
  execFileSync('bun', ['bin/slidewell.mjs', 'settings', 'set', 'capture.triageRoot', shots, '--agent', 'e2e'], { env: { ...process.env, SLIDEWELL_DATA_DIR: userData } })
  await win.waitForTimeout(1500)
  const SHOT = 'CleanShot 2026-10-20 at 0915 from Safari with Watched.png'
  writeFileSync(join(shots, SHOT), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  let seen = []
  for (let i = 0; i < 15 && seen.length < 1; i++) {
    await win.waitForTimeout(1000)
    seen = (await win.evaluate(() => window.sw.triage.list('', 'all', 'scanned', 50, 0))).items.filter((x) => x.filename.includes('Watched'))
  }
  r.watcherFollowsCli = seen.length === 1
} finally {
  await app.close()
}
const pass = Object.entries(r).every(([k, v]) => k === 'menuFrame' || k === 'cheatRows' || v === true)
out({ ...r, pass })
process.exit(pass ? 0 : 1)
