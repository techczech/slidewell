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
const movedExtra = join(work, 'Moved other screenshots')
mkdirSync(userData)
mkdirSync(source)
writeFileSync(join(source, 'keep.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
writeFileSync(join(source, 'undecided.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
writeFileSync(join(source, 'stored.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64'))
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
  const oldRows = await win.evaluate(async () => {
    await window.sw.triage.scan()
    const { items } = await window.sw.triage.list('', 'all')
    await window.sw.triage.decide(items.find((item) => item.filename === 'stored.png').hash, 'select')
    await window.sw.triage.importSelected()
    await window.sw.triage.decide(items.find((item) => item.filename === 'keep.png').hash, 'select')
    return (await window.sw.triage.list('', 'all')).items
  })
  assert.deepEqual(oldRows.map((row) => row.state).sort(), ['included', 'selected', 'undecided'])
  renameSync(source, replacement)
  renameSync(join(replacement, 'undecided.png'), join(replacement, 'renamed.png'))
  const choose = (folder) => app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, folder)
  const focusMain = () => app.evaluate(({ app, BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/renderer/index.html'))
    if (!main || main.isVisible()) throw new Error('Triage E2E window must be hidden')
    app.emit('browser-window-focus', {}, main)
  })
  await choose(replacement)
  await focusMain()

  const notice = win.getByRole('status').filter({ hasText: 'SlideWell can no longer find' })
  await notice.waitFor({ timeout: 5000 })
  assert.equal(await notice.count(), 1)
  assert.match(await notice.innerText(), /capture folder Screenshots at .*New screenshots from it are not arriving\./)
  assert.equal(await notice.getByRole('button', { name: 'Stop watching' }).count(), 1)
  result.triageNotice = true
  const storedCopy = await win.evaluate(async () => {
    const { items } = await window.sw.triage.list('', 'all')
    return items.find((item) => item.filename === 'stored.png')?.thumbUrl
  })
  assert.ok(storedCopy)
  assert.equal(await win.evaluate((url) => new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve(true)
    image.onerror = () => resolve(false)
    image.src = url
  }), storedCopy), true)
  result.storedCopyAvailable = true

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
  const identity = ({ hash, relPath, state }) => ({ hash, relPath, state })
  assert.equal(after.items.length, oldRows.length)
  const byHash = new Map(after.items.map((row) => [row.hash, row]))
  for (const old of oldRows) {
    const filename = old.filename === 'undecided.png' ? 'renamed.png' : old.filename
    assert.deepEqual(identity(byHash.get(old.hash)), { hash: old.hash, relPath: join(replacement, filename), state: old.state })
  }
  await win.getByRole('tab', { name: 'All' }).click()
  for (const filename of ['keep.png', 'renamed.png']) {
    const item = win.locator('.triage-card').filter({ hasText: filename })
    const img = item.locator('img')
    await img.waitFor({ timeout: 5000 })
    await win.waitForFunction((name) => [...document.querySelectorAll('.triage-card')].some((card) => {
      const picture = card.querySelector('img')
      return card.textContent.includes(name) && picture?.complete && picture.naturalWidth > 0
    }), filename, { timeout: 5000 })
  }
  const imported = await win.evaluate(() => window.sw.triage.importSelected())
  assert.equal(imported.imported, 1)
  assert.equal(imported.skipped, 0)
  const states = await win.evaluate(async () => (await window.sw.triage.list('', 'all')).items.map((row) => row.state).sort())
  assert.deepEqual(states, ['included', 'included', 'undecided'])
  result.movedRowsAndImportedSelection = true
  result.chooseFromTriage = true

  await choose(missingExtra)
  // Add a valid folder using the normal picker, then move it out and take the primary offline too.
  mkdirSync(missingExtra)
  assert.equal(await win.evaluate(() => window.sw.settings.addCaptureSource('folder')), true)
  renameSync(missingExtra, movedExtra)
  renameSync(replacement, source)
  await focusMain()
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

  await choose(movedExtra)
  await missing.filter({ hasText: missingExtra }).getByRole('button', { name: 'Choose folder…' }).click()
  await missing.filter({ hasText: missingExtra }).waitFor({ state: 'hidden', timeout: 5000 })
  assert.equal(await missing.count(), 1)
  assert.deepEqual((await win.evaluate(() => window.sw.settings.getPaths())).captureSources.map((s) => s.path), [movedExtra])
  result.chooseFromSettings = true
  await missing.filter({ hasText: replacement }).getByRole('button', { name: 'Stop watching' }).click()
  await missing.first().waitFor({ state: 'hidden', timeout: 5000 })
  assert.equal((await win.evaluate(() => window.sw.settings.getPaths())).screenshotRoot, null)
  result.stopFromSettings = true

  renameSync(movedExtra, missingExtra)
  await focusMain()
  await notice.getByRole('button', { name: 'Stop watching' }).click({ timeout: 5000 })
  await notice.waitFor({ state: 'hidden', timeout: 5000 })
  await win.getByRole('tab', { name: 'All' }).click()
  await win.locator('.triage-card').first().waitFor({ timeout: 5000 })
  assert.equal((await win.evaluate(() => window.sw.settings.getPaths())).captureSources.length, 0)
  result.stopFromTriage = true
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible())), true)
} catch (error) {
  failure = error.message
} finally {
  await app.close()
}
console.log(JSON.stringify(result))
finish(failure)
