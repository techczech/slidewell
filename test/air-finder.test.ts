import { createHash } from 'node:crypto'
import { request } from 'node:http'
import { expect, test } from 'vitest'
import sharp from 'sharp'
import { fixtureService } from './support/finder-service'
// @ts-expect-error Existing E2E fixture uses plain JavaScript.
import { SHOWN_SLIDE, OTHER_SLIDE, SHOWN_WELL } from '../e2e/support/finder-fixture.mjs'

test('searches real registries and ranks indexed items within the personal scope', async () => {
  const host = await fixtureService()
  try {
    const words = await (await host.request('/api/search?mode=words&q=lantern')).json()
    expect(words.items.map((item) => item.itemId)).toEqual([SHOWN_SLIDE, OTHER_SLIDE, `well:${SHOWN_WELL}`])
    expect(JSON.stringify(words)).not.toContain(host.fixture.scope.archiveRoot)
    const meaning = await (await host.request('/api/search?mode=meaning&q=glowing%20beacons')).json()
    expect(meaning.items.map((item) => item.itemId)).toEqual([SHOWN_SLIDE, OTHER_SLIDE, `well:${SHOWN_WELL}`])
    const neighbour = await (await host.request(`/api/related/${meaning.items[0].ref}`)).json()
    expect(neighbour.items.map((item) => item.itemId)).toEqual([OTHER_SLIDE, `well:${SHOWN_WELL}`])
    const [image] = words.items.filter((item) => item.corpusId === 'well')
    const preview = await host.request(`/api/preview/${image.ref}`)
    expect((await sharp(Buffer.from(await preview.arrayBuffer())).metadata()).width).toBe(480)
    const downloadPath = `/api/download/${image.ref}`
    const download = await host.request(downloadPath)
    expect(download.headers.get('x-slidewell-sha256')).toBe(createHash('sha256').update(host.fixture.bytes).digest('hex'))
    expect(Buffer.from(await download.arrayBuffer())).toEqual(host.fixture.bytes)
    expect(image).toMatchObject({ libraryId: 'fixture-library', corpusId: 'well', source: 'Added image · 2025-04-10' })
    expect(image.sourceRevision).toMatch(/^[a-f0-9]{64}$/)
    host.fixture.relabel(SHOWN_WELL, 'excluded')
    expect((await host.request(downloadPath)).status).toBe(404)
    expect((await host.request(`/api/preview/${image.ref}`)).status).toBe(404)
    host.expire()
    expect((await host.request(`/api/related/${meaning.items[0].ref}`)).status).toBe(410)
  } finally {
    await host.close()
  }
})

test('distinguishes denied, empty and unavailable searches and refuses caller paths and oversized queries', async () => {
  const host = await fixtureService()
  try {
    expect((await host.request('/api/search?mode=words&q=asteroid')).status).toBe(200)
    expect(await (await host.request('/api/search?mode=words&q=asteroid')).json()).toEqual({ items: [] })
    expect((await host.request('/api/search?mode=words&q=' + 'a'.repeat(201))).status).toBe(400)
    expect((await host.request('/api/download/%2Ftmp%2Fexample')).status).toBe(404)
    expect((await host.request('/api/library', { method: 'POST' })).status).toBe(405)
    host.setModelReady(false)
    expect((await host.request('/api/search?mode=meaning&q=glowing%20beacons')).status).toBe(503)
    const denied = await new Promise<number | undefined>((resolve, reject) => {
      request(host.base + '/api/library', { headers: { Origin: 'https://example.invalid' } }, (res) => {
        res.resume()
        resolve(res.statusCode)
      }).on('error', reject).end()
    })
    expect(denied).toBe(403)
  } finally {
    await host.close()
  }
})
