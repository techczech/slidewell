// Hidden Electron with a disposable profile and a loopback update feed.
// Run: npm run test:update-notices. The spec waits for two real startup check timers.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { finish } from './support/result.mjs'
import { createScratch, launchHidden } from './support/scratch.mjs'

const scratch = createScratch('updates')
const site = 'https://techczech.github.io/slidewell/'
const download = site + '#download'
const fixture = join(scratch, 'updates.json')
writeFileSync(fixture, JSON.stringify({ schema: 1, latest: {
  version: '99.0.0', released: '2026-11-21', summary: ['Synthetic update for the hidden Electron test.'],
  notes: site + '#notes', download: { mac: download, windows: download }
}}))
const requests = []
const server = createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/updates.json') {
    response.writeHead(404).end()
    return
  }
  requests.push({ method: request.method, url: request.url, headers: request.headers })
  response.setHeader('Content-Type', 'application/json')
  response.end(readFileSync(fixture))
})

async function withApp(profile, test) {
  const userData = join(scratch, profile)
  mkdirSync(userData)
  const app = await launchHidden(userData, join(scratch, profile + '-home'))
  try {
    const win = await app.firstWindow({ timeout: 20000 })
    await win.waitForFunction(() => Boolean(window.sw?.updates))
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((window) => !window.isVisible())), true)
    await test(app, win, userData)
  } finally {
    await app.close()
  }
}

try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  process.env.SLIDEWELL_E2E_UPDATES_FEED = `http://127.0.0.1:${server.address().port}/updates.json`

  await withApp('enabled', async (app, win) => {
    const mark = win.locator('[data-update-mark]')
    const notice = win.getByRole('dialog', { name: 'A new version is available' })
    const openNotice = async () => {
      await mark.click()
      await notice.waitFor()
    }
    const check = () => win.evaluate(() => window.sw.updates.check())
    await mark.waitFor({ timeout: 160000 })
    assert.match(await mark.innerText(), /99\.0\.0/)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].headers['user-agent'], 'SlideWell')
    assert.equal(requests[0].headers.cookie, undefined)
    console.log('PASS scheduled check showed the update mark from the loopback feed')

    const output = []
    app.process().stdout?.on('data', (chunk) => output.push(String(chunk)))
    await openNotice()
    if (process.env.SLIDEWELL_UPDATES_SCREEN) await win.screenshot({ path: process.env.SLIDEWELL_UPDATES_SCREEN })
    await notice.getByRole('button', { name: 'Download', exact: true }).click()
    const deadline = Date.now() + 5000
    while (!output.join('').includes('[updates] Test browser link: ' + download) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.ok(output.join('').includes('[updates] Test browser link: ' + download), 'Download did not dispatch the feed link')
    assert.equal(requests.length, 1)
    console.log('PASS Download dispatched only the validated browser link')

    await openNotice()
    await notice.getByRole('button', { name: 'Not now', exact: true }).click()
    await mark.waitFor({ state: 'hidden' })
    assert.ok((await win.evaluate(() => window.sw.updates.get())).state.snoozedUntil > Date.now())
    await check()
    await mark.waitFor()
    console.log('PASS Not now hid the notice and a manual check offered it again')

    await openNotice()
    await notice.getByRole('button', { name: 'Skip this version', exact: true }).click()
    await mark.waitFor({ state: 'hidden' })
    const skipped = await check()
    assert.equal(skipped.state.skippedVersion, '99.0.0')
    assert.equal(skipped.mark, null)
    console.log('PASS Skip this version persisted and suppressed the same release')

    const beforePalette = requests.length
    await win.keyboard.press('Meta+k')
    await win.locator('.cmd-palette').getByRole('button', { name: 'Check for Updates…', exact: true }).click()
    await win.locator('.sw-update-answer').waitFor()
    assert.equal(requests.length, beforePalette + 1)
    console.log('PASS the Search command palette ran a manual update check')
  })

  await withApp('disabled', async (app, win, userData) => {
    const initialRequests = requests.length
    const [settings] = await Promise.all([
      app.waitForEvent('window', { timeout: 15000 }),
      win.evaluate(() => window.sw.app.openSettings('updates'))
    ])
    const daily = settings.getByRole('checkbox', { name: 'Check for new versions daily' })
    await daily.waitFor({ timeout: 15000 })
    assert.equal(await daily.isChecked(), true)
    // The controlled checkbox follows the result of a Settings IPC write.
    await daily.click()
    await win.waitForFunction(async () => !(await window.sw.updates.get()).enabled)
    await daily.and(settings.locator('input:not(:checked)')).waitFor()
    assert.equal(await daily.isChecked(), false)
    const saved = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))
    assert.equal(saved.settings['updates.checkForNewVersions'], false)
    // The enabled profile established that a fresh run normally checks at two minutes.
    await new Promise((resolve) => setTimeout(resolve, 125000))
    assert.equal(requests.length, initialRequests, 'daily request reached the feed with the Settings switch off')
    assert.equal(await win.locator('[data-update-mark]').count(), 0)
    console.log('PASS Settings switch off suppressed the scheduled request on a fresh profile')
  })
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
finish()
