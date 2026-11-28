import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { MODEL_DIM, MODEL_DIR_NAME } from '../src/main/picture-search/model-manifest.ts'
import { copyCachedPictureModel, readVerifiedPictureModel } from './support/cached-picture-model.mjs'
import { HIDDEN_WELL, makeFinderFixture, OTHER_SLIDE, OUT_OF_SCOPE_SLIDE, SHOWN_SLIDE, SHOWN_WELL } from './support/finder-fixture.mjs'
import { launchHidden } from './support/scratch.mjs'
import { finish } from './support/result.mjs'

const scratch = process.env.SLIDEWELL_COLD_FINDER_ROOT
assert(scratch, 'Set SLIDEWELL_COLD_FINDER_ROOT to a private scratch directory')
assert(!process.env.SLIDEWELL_E2E_EXECUTABLE, 'Use the source build')
const cache = realpathSync(scratch)
const model = readVerifiedPictureModel(join(cache, MODEL_DIR_NAME))
const root = mkdtempSync(join(cache, 'f-'))
const browserPort = 8870
const wordsPath = '/api/search?mode=words&q=lantern'
const wellId = `well:${SHOWN_WELL}`
const otherSecondSlide = 'slide:fixture-deck-2#2'
const expected = [wellId, OTHER_SLIDE, otherSecondSlide]
const fixture = await makeFinderFixture(root)
const { scope } = fixture
const storePath = join(scope.wellRoot, 'picture-search.db')

function vector(score) {
  const buffer = Buffer.alloc(MODEL_DIM * 4)
  buffer.writeFloatLE(score, 0)
  buffer.writeFloatLE(Math.sqrt(1 - score ** 2), 4)
  return buffer
}

function seedVectors() {
  const db = new DatabaseSync(storePath)
  try {
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE vectors(id TEXT PRIMARY KEY, kind TEXT NOT NULL,
        presentation_id TEXT, slide_order INTEGER, well_id TEXT, path TEXT NOT NULL,
        file_size INTEGER NOT NULL, file_mtime_ms INTEGER NOT NULL, embedded_at TEXT NOT NULL,
        vector BLOB NOT NULL);
      BEGIN`)
    db.prepare('INSERT INTO meta VALUES (?, ?)').run('slide_archive_root', scope.archiveRoot)
    const add = db.prepare("INSERT INTO vectors VALUES (?, ?, NULL, NULL, NULL, '', 0, 0, '', ?)")
    add.run(SHOWN_SLIDE, 'slide', vector(1))
    add.run('slide:fixture-deck-1#2', 'slide', vector(1))
    add.run(OUT_OF_SCOPE_SLIDE, 'slide', vector(1))
    add.run(`well:${HIDDEN_WELL}`, 'well-image', vector(1))
    add.run('well:f00000000001', 'well-image', vector(1))
    // Equal scores across kinds must retain the original scan order.
    add.run(wellId, 'well-image', vector(0.8))
    add.run(OTHER_SLIDE, 'slide', vector(0.8))
    add.run(otherSecondSlide, 'slide', vector(0.6))
    const low = vector(0.1)
    const high = vector(1)
    for (let deck = 0; deck < 360; deck++) {
      const id = `invented-${deck}`
      if (deck < 359) scope.presentations.push(id)
      for (let order = 1; order <= 100; order++) {
        add.run(`slide:${id}#${order}`, 'slide', deck < 359 ? low : high)
      }
    }
    for (let i = 0; i < 6300; i++) add.run(`triage:invented-${i}`, 'triage', high)
    db.exec('COMMIT')
  } finally {
    db.close()
  }
}

const timestamp = () => performance.timeOrigin + performance.now()
function query(socketPath, path, started = timestamp()) {
  return new Promise((resolve, reject) => {
    request({ socketPath, path, headers: { Host: `127.0.0.1:${browserPort}` }, timeout: 20_000 }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => {
        const ended = timestamp()
        try {
          const bytes = Buffer.concat(chunks)
          const body = res.headers['content-type'] === 'application/json' ? JSON.parse(bytes) : bytes
          resolve({ status: res.statusCode, body, started, ended })
        } catch (error) {
          reject(error)
        }
      })
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('Request timed out')) }).end()
  })
}

async function markMain(app) {
  await app.evaluate(({ BrowserWindow }) => {
    if (BrowserWindow.getAllWindows().some((window) => window.isVisible())) throw new Error('Expected hidden Electron windows')
    const stamp = () => performance.timeOrigin + performance.now()
    const probe = { last: stamp(), maxGap: 0, rankStart: null, rankEnd: null }
    probe.tick = () => {
      const now = stamp()
      probe.maxGap = Math.max(probe.maxGap, now - probe.last)
      probe.last = now
    }
    probe.timer = setInterval(probe.tick, 2)
    const Worker = process.getBuiltinModule('node:worker_threads').Worker
    const postMessage = Worker.prototype.postMessage
    Worker.prototype.postMessage = function (message, ...args) {
      if (message?.imageId && probe.rankStart === null) {
        probe.rankStart = stamp()
        this.prependOnceListener('message', () => { probe.rankEnd = stamp() })
      }
      return postMessage.call(this, message, ...args)
    }
    probe.restore = () => { Worker.prototype.postMessage = postMessage }
    globalThis.finderTimingProbe = probe
  })
}

async function readMain(app) {
  return app.evaluate(() => {
    const probe = globalThis.finderTimingProbe
    clearInterval(probe.timer)
    probe.restore()
    probe.tick()
    return { maxGap: probe.maxGap, rankStart: probe.rankStart, rankEnd: probe.rankEnd }
  })
}

function assertItems(result, ids) {
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.deepEqual(result.body.items.map(({ itemId }) => itemId), ids)
}

async function run(round, checkStale) {
  const launch = join(root, String(round))
  const profile = join(launch, 'p')
  const socketPath = join(launch, 'f.sock')
  const configPath = join(launch, 'finder.json')
  assert(Buffer.byteLength(join(profile, 'picture-query.sock')) <= 103, 'Use a shorter scratch path')
  mkdirSync(launch, { mode: 0o700 })
  mkdirSync(profile, { mode: 0o700 })
  copyCachedPictureModel(model, profile)
  writeFileSync(join(profile, 'config.json'), JSON.stringify({
    archiveRoot: scope.archiveRoot, wellRoot: scope.wellRoot,
    othersArchiveRoot: join(root, 'no-others'), vaultRoot: join(root, 'no-vault'),
    screenshotRoot: join(root, 'no-captures'), pictureSearch: { paused: true }
  }))
  writeFileSync(configPath, JSON.stringify({ ...scope, socketPath, browserPort, meaningVerified: true }), { mode: 0o600 })
  const app = await launchHidden(profile, join(launch, 'home'), {
    args: [`--air-finder-config=${configPath}`], isolatePreferences: true
  })
  try {
    const deadline = Date.now() + 15_000
    while (!existsSync(socketPath) && Date.now() < deadline) await delay(50)
    assert(existsSync(socketPath), 'Finder endpoint did not start')
    const local = (path) => query(socketPath, path)
    const window = await app.firstWindow()
    await window.waitForFunction(() => Boolean(globalThis.sw?.picture))
    for (;;) {
      const { index } = await window.evaluate(() => globalThis.sw.picture.status())
      if (index.phase === 'paused') break
      assert.notEqual(index.phase, 'error', index.error)
      assert(Date.now() < deadline, 'Synthetic picture index did not settle in paused mode')
      await delay(50)
    }
    const status = await local('/api/library')
    assert.equal(status.status, 200)
    assert.equal(status.body.meaning, true)
    const words = await local(wordsPath)
    assertItems(words, [SHOWN_SLIDE, OTHER_SLIDE, wellId])
    const seed = words.body.items[0].ref
    await markMain(app)
    const related = local(`/api/related/${seed}`)
    await delay(25)
    const [result, concurrentWords, concurrentStatus] = await Promise.all([related, local(wordsPath), local('/api/library')])
    const { maxGap, rankStart, rankEnd } = await readMain(app)
    const duringRank = (response) => rankStart !== null && rankStart <= response.ended && response.ended <= rankEnd
    const elapsed = (response) => Number((response.ended - response.started).toFixed(1))
    const timing = {
      round, maxGapMs: Number(maxGap.toFixed(1)), relatedMs: elapsed(result),
      wordsMs: elapsed(concurrentWords), statusMs: elapsed(concurrentStatus),
      rankMs: rankStart === null || rankEnd === null ? null : Number((rankEnd - rankStart).toFixed(1)),
      wordsDuringRank: duringRank(concurrentWords), statusDuringRank: duringRank(concurrentStatus)
    }
    console.log('COLD_FINDER', JSON.stringify(timing))
    assertItems(result, expected)
    assertItems(concurrentWords, [SHOWN_SLIDE, OTHER_SLIDE, wellId])
    assert.equal(concurrentStatus.status, 200)
    assert.equal(concurrentStatus.body.meaning, true)
    if (checkStale) {
      if (rankStart !== null) {
        const writer = new DatabaseSync(storePath)
        try {
          writer.prepare('UPDATE vectors SET vector = ? WHERE id = ?').run(vector(0.95), otherSecondSlide)
        } finally {
          writer.close()
        }
        assertItems(await local(`/api/related/${seed}`), [otherSecondSlide, wellId, OTHER_SLIDE])
      }
      const wellRef = result.body.items[0].ref
      fixture.relabel(SHOWN_WELL, 'emptied')
      assert.equal((await local(`/api/related/${wellRef}`)).status, 404)
      assert.equal((await local(`/api/preview/${wellRef}`)).status, 404)
      assert.equal((await local(`/api/download/${wellRef}`)).status, 404)
      assertItems(await local(`/api/related/${seed}`), rankStart === null ? expected.slice(1) : [otherSecondSlide, OTHER_SLIDE])
      const render = join(scope.archiveRoot, 'extracted', 'fixture-deck-1', 'renders', 'slide_0001.webp')
      writeFileSync(render, fixture.bytes)
      assert.equal((await local(`/api/related/${seed}`)).status, 404)
    }
    return timing
  } finally {
    await app.close()
    assert(!existsSync(socketPath), 'Finder endpoint survived app shutdown')
  }
}

console.log(`Cold finder scratch: ${root}; 42308 vectors of ${MODEL_DIM} dimensions`)
seedVectors()
const samples = []
for (let round = 1; round <= 3; round++) samples.push(await run(round, round === 3))
assert(samples.every(({ maxGapMs }) => maxGapMs < 120), 'Cold Related blocked the Electron main loop for at least 120 ms')
assert(samples.every(({ wordsDuringRank, statusDuringRank }) => wordsDuringRank && statusDuringRank),
  'Words and library status must complete while cold Related ranking is in flight')
console.log('PASS: hidden Electron socket, concurrent Words and status, Related order and scope, vector refresh, stale refs, and shutdown')
finish(null)
