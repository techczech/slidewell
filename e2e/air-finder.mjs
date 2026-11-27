import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { launchHidden } from './support/scratch.mjs'
import { makeFinderFixture, SHOWN_SLIDE, SHOWN_WELL } from './support/finder-fixture.mjs'

const scratch = process.env.SLIDEWELL_FINDER_SCRATCH
assert(scratch && /^\/tmp\/swf\.[A-Za-z0-9]+$/.test(scratch), 'Specify a fresh /tmp/swf.XXXXXX scratch directory')
assert(!process.env.SLIDEWELL_E2E_EXECUTABLE, 'The finder journey requires the source build')
const root = realpathSync(scratch)
const { scope, bytes } = await makeFinderFixture(root)
const profile = join(root, 'profile')
const home = join(root, 'home')
const socket = join(root, 'finder.sock')
const browserPort = 8870
const config = join(root, 'finder.json')
mkdirSync(profile)
writeFileSync(join(profile, 'config.json'), JSON.stringify({
  archiveRoot: scope.archiveRoot, wellRoot: scope.wellRoot,
  othersArchiveRoot: join(root, 'no-others'), vaultRoot: join(root, 'no-vault')
}))
writeFileSync(config, JSON.stringify({ ...scope, socketPath: socket, browserPort }), { mode: 0o600 })

function query(path) {
  return new Promise((resolve, reject) => {
    request({ socketPath: socket, path, headers: { Host: `127.0.0.1:${browserPort}` }, timeout: 20_000 }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => resolve({ response: res, bytes: Buffer.concat(chunks) }))
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('Request timed out')) }).end()
  })
}

const app = await launchHidden(profile, home, { args: [`--air-finder-config=${config}`], isolatePreferences: true })
try {
  const deadline = Date.now() + 15_000
  while (!existsSync(socket) && Date.now() < deadline) await delay(100)
  assert(existsSync(socket), 'Finder endpoint did not start')
  const describe = await query('/api/library')
  assert.equal(describe.response.statusCode, 200)
  assert.equal(JSON.parse(describe.bytes).meaning, false)
  const response = await query('/api/search?mode=words&q=lantern')
  assert.equal(response.response.statusCode, 200, response.bytes.toString())
  const { items } = JSON.parse(response.bytes)
  assert(items.some((item) => item.itemId === SHOWN_SLIDE))
  const image = items.find((item) => item.itemId === `well:${SHOWN_WELL}`)
  assert(image)
  assert.deepEqual((await query(`/api/download/${image.ref}`)).bytes, bytes)
  console.log('PASS: hidden source-build app, private socket, Words, source identity, original bytes')
  if (process.env.SLIDEWELL_FINDER_TEST_AIR === '1') {
    const output = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6',
      '-o', 'ExitOnForwardFailure=yes', '-R', `127.0.0.1:${browserPort}:${socket}`, 'air', 'python3 -'
    ], { input: `
import hashlib, json, time, urllib.request
base = 'http://127.0.0.1:${browserPort}'

def get(path):
    t = time.monotonic()
    with urllib.request.urlopen(base + path, timeout=20) as r:
        data = r.read()
        return data, dict(r.headers), int((time.monotonic() - t) * 1000)

doc, _, _ = get('/')
assert b'SlideWell Air finder' in doc
items, _, query_ms = get('/api/search?mode=words&q=lantern')
item = next(i for i in json.loads(items)['items'] if i['itemId'] == 'well:${SHOWN_WELL}')
ref = item['ref']
preview, _, preview_ms = get('/api/preview/' + ref)
download, headers, _ = get('/api/download/' + ref)
assert hashlib.sha256(download).hexdigest() == headers['X-SlideWell-SHA256']
print(json.dumps(dict(query_ms=query_ms, preview_ms=preview_ms, preview_bytes=len(preview), download_bytes=len(download))))
`, encoding: 'utf8', timeout: 45_000, stdio: ['pipe', 'pipe', 'ignore'] })
    console.log('PASS: Air over tailnet SSH', output.trim())
  }
} finally {
  await app.close()
}
assert(!existsSync(socket), 'Finder endpoint survived app shutdown')
