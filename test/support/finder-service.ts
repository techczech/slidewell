import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { PictureSearchEngine } from '../../src/main/picture-search/engine'
import { VectorStore } from '../../src/main/picture-search/vector-store'
import { createCatalogue } from '../../src/main/air-finder/catalogue-client'
import { finderServer } from '../../src/main/air-finder/server'
// @ts-expect-error Existing E2E fixture uses plain JavaScript.
import { makeFinderFixture, SHOWN_SLIDE, OTHER_SLIDE, OUT_OF_SCOPE_SLIDE, SHOWN_WELL, HIDDEN_WELL } from '../../e2e/support/finder-fixture.mjs'

async function loopbackPort() {
  const probe = createServer().listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => { probe.once('listening', resolve); probe.once('error', reject) })
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

export async function fixtureService() {
  const root = mkdtempSync(join(tmpdir(), 'finder-api-'))
  const fixture = await makeFinderFixture(root)
  const store = new VectorStore(join(root, 'picture-search.db'))
  const lantern = Float32Array.from([1, 0])
  for (const [id, vector] of [
    [SHOWN_SLIDE, [0.9, 0.4]], [OTHER_SLIDE, [0.85, 0.5]], [OUT_OF_SCOPE_SLIDE, [1, 0]],
    [`well:${SHOWN_WELL}`, [0.8, 0.6]], [`well:${HIDDEN_WELL}`, [1, 0]], ['triage:b20000000001', [1, 0]]
  ] as Array<[string, number[]]>) {
    store.put({ id, kind: id.startsWith('slide:') ? 'slide' : id.startsWith('well:') ? 'well-image' : 'triage',
      path: '', size: 0, mtimeMs: 0 }, Float32Array.from(vector))
  }
  const embedding = {
    embedText: async (text: string) => {
      if (text !== 'glowing beacons') throw new Error('Words lookup must not embed')
      return lantern
    },
    embedImage: async () => lantern
  }
  const pictures = new PictureSearchEngine(store, () => embedding)
  const catalogue = await createCatalogue(fixture.scope)
  let ready = true
  let now = Date.now()
  const port = await loopbackPort()
  const server = finderServer({
    catalogue, browserPort: port, now: () => now,
    pictures: { ready: () => ready, query: pictures.pictureQuery.bind(pictures) }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const base = `http://127.0.0.1:${port}`
  return {
    fixture, base, request: (path: string, init?: RequestInit) => fetch(base + path, init),
    expire: () => { now += 11 * 60_000 },
    setModelReady: (value: boolean) => { ready = value },
    close: async () => {
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() })
      store.close()
    }
  }
}
