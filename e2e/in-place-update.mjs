// Disposable packaged/macOS test. No Developer ID or notarisation credentials are used.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { constants, cpSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'
import { finish } from './support/result.mjs'

assert.equal(process.platform, 'darwin')
assert.equal(process.arch, 'arm64')

const root = mkdtempSync('/tmp/swup-')
const id = 'net.dominiklukes.slidewell.updatetest'
const appName = 'SlideWell Update Test'
const baseVersion = '1.0.0'
const nextVersion = '1.0.1'
const site = 'https://techczech.github.io/slidewell/'
const targetZip = 'SlideWell-mac-arm64.zip'
const assetPath = `/releases/download/v${nextVersion}/${targetZip}`
console.log('Fixture build and ZIPs:', root)
const buildHome = join(root, 'builder-home')
mkdirSync(buildHome)

function run(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', ...options })
}

function build(version) {
  const out = join(root, version)
  run('./node_modules/.bin/electron-builder', [
    '--mac', 'dir', '--arm64', '--publish', 'never', '--config', 'build/electron-builder.update-test.cjs',
    `-c.extraMetadata.version=${version}`, `-c.directories.output=${out}`
  ], {
    env: { PATH: process.env.PATH, HOME: buildHome, TMPDIR: root, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    stdio: 'inherit'
  })
  const bundle = join(out, 'mac-arm64', appName + '.app')
  // The fixture alone has a certificate-free designated requirement shared across its versions.
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle])
  run('/usr/bin/codesign', ['--force', '--sign', '-', '-r', `=designated => identifier "${id}"`, bundle])
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle])
  return bundle
}

const source = build(baseVersion)
const target = build(nextVersion)

async function zip(bundle, name) {
  const path = join(root, name)
  run('/usr/bin/ditto', ['-c', '-k', '--keepParent', bundle, path])
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return { path, size: statSync(path).size, sha512: hash.digest('base64') }
}

const good = await zip(target, targetZip)
const old = await zip(source, 'wrong-version.zip')
const altered = join(root, 'altered', appName + '.app')
mkdirSync(join(root, 'altered'))
cpSync(target, altered, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
writeFileSync(join(altered, 'Contents', 'Resources', 'changed-after-signing.txt'), 'Invalidates the disposable bundle signature.')
assert.notEqual(spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', altered]).status, 0)
const wrongSignature = await zip(altered, 'wrong-signature.zip')

const requests = []
let asset = good
let advertised = good
let pauseDownload = false
let malformed = false
const server = createServer((req, res) => {
  requests.push(req.url)
  if (req.url === '/updates.json') {
    const latest = {
      version: nextVersion, released: '2026-11-22', summary: ['Disposable update.'],
      notes: site + '#notes', download: { mac: site + '#download', windows: site + '#download' }
    }
    const mac = { url: origin + assetPath, sha512: advertised.sha512, size: advertised.size, bundleId: malformed ? 'wrong.id' : id }
    return res.end(JSON.stringify({ schema: 1, latest, channels: { release: { ...latest, update: { mac } } } }))
  }
  if (req.url === assetPath) {
    res.writeHead(200, { 'Content-Length': asset.size })
    res.flushHeaders()
    if (!pauseDownload) createReadStream(asset.path).pipe(res)
    return
  }
  res.writeHead(404).end()
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
const assetCount = () => requests.filter((url) => url === assetPath).length

function createProfile(label) {
  const dir = mkdtempSync('/tmp/swup-')
  const bundle = join(dir, appName + '.app')
  cpSync(source, bundle, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  writeFileSync(join(dir, 'fixture-marker'), label)
  writeFileSync(join(dir, 'fixture-feed.txt'), origin + '/updates.json')
  const profile = join(dir, 'profile')
  mkdirSync(profile)
  mkdirSync(join(dir, 'home'))
  const config = join(profile, 'config.json')
  writeFileSync(config, JSON.stringify({
    wellRoot: join(dir, 'well'), archiveRoot: join(dir, 'absent-archive'),
    othersArchiveRoot: join(dir, 'others'), screenshotRoot: join(dir, 'captures'), conversionsRoot: join(dir, 'conversions'),
    windowBounds: { width: 1200, height: 800 },
    updateFixtureSentinel: 'preserve me'
  }))
  console.log(`Fixture ${label}:`, dir)
  return { dir, bundle, config, profile, executable: join(bundle, 'Contents', 'MacOS', appName) }
}

const versionOf = ({ bundle }) => run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(bundle, 'Contents', 'Info.plist')]).trim()
async function waitFor(predicate, timeout = 30000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for the disposable update fixture')
}

async function withApp(fixture, test) {
  const env = { ...process.env, HOME: join(fixture.dir, 'home') }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ executablePath: fixture.executable, args: ['--use-mock-keychain'], env })
  const child = app.process()
  child.stdout?.on('data', (data) => process.stdout.write(data))
  child.stderr?.on('data', (data) => process.stderr.write(data))
  try {
    const win = await app.firstWindow()
    await win.waitForFunction(() => Boolean(window.sw?.updates))
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible())), true)
    return await test(app, win, child)
  } finally {
    if (child.exitCode === null && child.signalCode === null) await app.close()
  }
}

async function offer(win) {
  const before = assetCount()
  const check = await win.evaluate(() => window.sw.updates.check())
  assert.equal(check.mark?.version, nextVersion)
  assert.equal(check.install.phase, 'idle')
  assert.equal(assetCount(), before, 'a manual check started an asset download')
  await win.locator('[data-update-mark]').click()
}

function original(fixture) {
  assert.equal(versionOf(fixture), baseVersion)
  assert.equal(JSON.parse(readFileSync(fixture.config, 'utf8')).updateFixtureSentinel, 'preserve me')
}

try {
  const cancelled = createProfile('cancelled')
  await withApp(cancelled, async (_app, win) => {
    await offer(win)
    pauseDownload = true
    const before = assetCount()
    await win.getByRole('button', { name: 'Update', exact: true }).click()
    await waitFor(() => assetCount() === before + 1)
    await win.getByRole('button', { name: 'Cancel', exact: true }).click()
    await waitFor(async () => (await win.evaluate(() => window.sw.updates.get())).install.phase === 'idle')
    pauseDownload = false
  })
  original(cancelled)
  console.log('PASS Update clicked, download cancelled, ordinary quit left the signed bundle and profile intact')

  const held = createProfile('held')
  await withApp(held, async (app, win) => {
    await offer(win)
    const [settings] = await Promise.all([
      app.waitForEvent('window'),
      win.evaluate(() => window.sw.app.openSettings('updates'))
    ])
    await settings.getByText('Check for new versions daily').waitFor()
    await win.getByRole('button', { name: 'Update', exact: true }).click()
    await waitFor(async () => (await win.evaluate(() => window.sw.updates.get())).install.phase === 'waiting', 45000)
    original(held)
  })
  original(held)
  console.log('PASS verified update waiting behind Settings stayed unarmed through ordinary quit')

  const blocked = createProfile('failed-write')
  await withApp(blocked, async (_app, win) => {
    await offer(win)
    writeFileSync(blocked.config, '{"windowBounds":')
    await win.getByRole('button', { name: 'Update', exact: true }).click()
    await waitFor(async () => (await win.evaluate(() => window.sw.updates.get())).install.phase === 'waiting', 45000)
    const { blockers } = await win.evaluate(() => window.sw.updates.get())
    assert.ok(blockers.includes('unsaved'), `Expected the unreadable config to hold restart, got ${JSON.stringify(blockers)}`)
    assert.equal(await win.getByRole('button', { name: 'Restart', exact: true }).isDisabled(), true)
  })
  assert.equal(versionOf(blocked), baseVersion)
  assert.equal(readFileSync(blocked.config, 'utf8'), '{"windowBounds":')
  console.log('PASS unreadable profile blocked restart and survived ordinary quit byte-for-byte')

  const invalid = createProfile('invalid-feed')
  await withApp(invalid, async (_app, win) => {
    malformed = true
    const before = assetCount()
    const snap = await win.evaluate(() => window.sw.updates.check())
    assert.equal(snap.state.lastResult, 'unreadable')
    assert.equal(snap.mark, null)
    await win.evaluate((v) => window.sw.updates.update(v), nextVersion)
    assert.equal(assetCount(), before)
    malformed = false
  })
  original(invalid)
  console.log('PASS malformed feed could not authorise a download or replacement')

  for (const [label, served, expected, reason] of [
    ['wrong-zip', old, good, 'mismatch'],
    ['wrong-version', old, old, 'wrong-version'],
    ['wrong-signature', wrongSignature, wrongSignature, 'signature']
  ]) {
    const fixture = createProfile(label)
    asset = served
    advertised = expected
    await withApp(fixture, async (app, win) => {
      await offer(win)
      await win.getByRole('button', { name: 'Update', exact: true }).click()
      // The native case closes and reopens the main window when the signature is refused.
      await waitFor(() => app.windows().some((page) => !page.isClosed()))
      const deadline = Date.now() + 90000
      let result
      while (Date.now() < deadline) {
        const page = app.windows().find((p) => !p.isClosed()) ?? win
        result = await page.evaluate(() => window.sw?.updates.get()).catch(() => null)
        if (result?.install.phase === 'failed') break
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      assert.equal(result?.install.phase, 'failed')
      assert.equal(result.install.reason, reason)
    })
    original(fixture)
    console.log(`PASS ${label} refused and ordinary quit kept the original bundle and profile`)
  }

  const fixture = createProfile('success')
  asset = good
  advertised = good
  await withApp(fixture, async (_app, win, child) => {
    await offer(win)
    const before = assetCount()
    const exit = once(child, 'exit')
    await win.getByRole('button', { name: 'Update', exact: true }).click()
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 90000)
    await exit
    assert.equal(assetCount(), before + 1)
  })
  const bootPath = join(fixture.dir, 'fixture-boot.json')
  await waitFor(() => {
    const errorFile = join(fixture.dir, 'fixture-start-error.txt')
    if (existsSync(errorFile)) throw new Error(readFileSync(errorFile, 'utf8'))
    try { return JSON.parse(readFileSync(bootPath, 'utf8')).version === nextVersion } catch { return false }
  }, 90000)
  const boot = JSON.parse(readFileSync(bootPath, 'utf8'))
  assert.equal(boot.userData, realpathSync(fixture.profile))
  assert.equal(boot.hidden, true)
  assert.equal(JSON.parse(readFileSync(join(fixture.profile, 'update-notices.json'), 'utf8')).lastVersionRun, nextVersion)
  assert.equal(versionOf(fixture), nextVersion)
  assert.equal(JSON.parse(readFileSync(fixture.config, 'utf8')).updateFixtureSentinel, 'preserve me')
  assert.ok(existsSync(join(fixture.profile, 'settings.json')))
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', fixture.bundle])
  console.log('PASS one click downloaded once, replaced the signed bundle in place, relaunched it and retained the same profile')
  // ShipIt relaunches outside Playwright. End only the synthetic executable at this exact path.
  const command = `/private${fixture.executable}`
  const processes = run('/bin/ps', ['-axww', '-o', 'pid=,comm=']).trim().split('\n')
  for (const line of processes) {
    const match = /^(\d+)\s+(.+)$/.exec(line.trim())
    if (match?.[2] === fixture.executable || match?.[2] === command) process.kill(Number(match[1]), 'SIGTERM')
  }
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
finish()
