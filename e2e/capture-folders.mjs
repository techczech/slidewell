// Hidden Electron test. Uses a disposable profile and stubs the native picker in the main process.
import assert from 'node:assert/strict'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { finish } from './support/result.mjs'
import { createScratch, launchHidden } from './support/scratch.mjs'

const work = createScratch('missing-capture')
const userData = join(work, 'userData')
const source = join(work, 'Screenshots')
const replacement = join(work, 'Moved screenshots')
const missingExtra = join(work, 'Other screenshots')
mkdirSync(userData)
mkdirSync(source)
writeFileSync(join(source, 'keep.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
writeFileSync(join(userData, 'config.json'), JSON.stringify({
  archiveRoot: join(work, 'archive'),
  wellRoot: join(work, 'well'),
  screenshotRoot: source
}))

const app = await launchHidden(userData, join(work, 'home'))
const result = {}
let failure
try {
  const win = await app.firstWindow({ timeout: 20_000 })
  await win.locator('.view-switch .scope-tab', { hasText: 'Triage' }).click()
  const oldRow = await win.evaluate(async () => {
    await window.sw.triage.scan()
    const { items } = await window.sw.triage.list('', 'all')
    const row = items.find((item) => item.filename === 'keep.png')
    await window.sw.triage.decide(row.hash, 'exclude')
    return row
  })
  renameSync(source, replacement)
  const mainWindow = await app.browserWindow(win)
  await mainWindow.evaluate((window, folder) => {
    if (window.isVisible()) throw new Error('Triage E2E window must be hidden')
    const { app, dialog } = require('electron')
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    app.emit('browser-window-focus', {}, window)
  }, replacement)

  const notice = win.getByRole('status').filter({ hasText: 'SlideWell can no longer find' })
  await notice.waitFor({ timeout: 5000 })
  assert.equal(await notice.count(), 1)
  assert.match(await notice.innerText(), /capture folder Screenshots at .*New screenshots from it are not arriving\./)
  assert.equal(await notice.getByRole('button', { name: 'Stop watching' }).count(), 1)
  result.triageNotice = true

  await notice.getByRole('button', { name: 'Choose folder…' }).click()
  await notice.waitFor({ state: 'hidden', timeout: 5000 })
  const after = await win.evaluate(async () => {
    await window.sw.triage.scan()
    return {
      root: (await window.sw.settings.getPaths()).screenshotRoot,
      items: (await window.sw.triage.list('', 'all')).items
    }
  })
  assert.equal(after.root, replacement)
  assert.deepEqual(after.items.map(({ hash, relPath, state }) => ({ hash, relPath, state })), [
    { hash: oldRow.hash, relPath: oldRow.relPath, state: 'excluded' }
  ])
  result.chooseFromTriage = true

  await mainWindow.evaluate((_window, folder) => {
    require('electron').dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, missingExtra)
  // Add a valid folder using the normal picker, then move it out and take the primary offline too.
  mkdirSync(missingExtra)
  assert.equal(await win.evaluate(() => window.sw.settings.addCaptureSource('folder')), true)
  renameSync(missingExtra, join(work, 'Moved other screenshots'))
  renameSync(replacement, source)
  await mainWindow.evaluate((window) => require('electron').app.emit('browser-window-focus', {}, window))
  await notice.filter({ hasText: '2 capture folders' }).waitFor({ timeout: 5000 })
  assert.equal(await notice.count(), 1)
  const [settings] = await Promise.all([
    app.waitForEvent('window', { timeout: 10_000 }),
    notice.getByRole('button', { name: 'Open Settings' }).click()
  ])
  const missing = settings.locator('.sw-page-row.bad')
  await missing.filter({ hasText: missingExtra }).waitFor({ timeout: 5000 })
  assert.equal(await missing.count(), 2)
  result.singleNoticeAndSettings = true

  await mainWindow.evaluate((_window, folder) => {
    require('electron').dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, source)
  await missing.filter({ hasText: replacement }).getByRole('button', { name: 'Choose folder…' }).click()
  await missing.filter({ hasText: replacement }).waitFor({ state: 'hidden', timeout: 5000 })
  assert.equal(await missing.count(), 1)
  result.chooseFromSettings = true
  await missing.filter({ hasText: missingExtra }).getByRole('button', { name: 'Stop watching' }).click()
  await missing.first().waitFor({ state: 'hidden', timeout: 5000 })
  assert.equal((await win.evaluate(() => window.sw.settings.getPaths())).captureSources.length, 0)
  result.stopFromSettings = true

  renameSync(source, replacement)
  await mainWindow.evaluate((window) => require('electron').app.emit('browser-window-focus', {}, window))
  await notice.getByRole('button', { name: 'Stop watching' }).click({ timeout: 5000 })
  await notice.waitFor({ state: 'hidden', timeout: 5000 })
  await win.getByRole('tab', { name: 'All' }).click()
  await win.locator('.triage-card').first().waitFor({ timeout: 5000 })
  assert.equal((await win.evaluate(() => window.sw.settings.getPaths())).screenshotRoot, null)
  result.stopFromTriage = true
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible())), true)
} catch (error) {
  failure = error.message
} finally {
  await app.close()
}
console.log(JSON.stringify(result))
finish(failure)
