import { createHash } from 'node:crypto'
import { chmod, lstat, mkdtemp, realpath, rename, truncate, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import sharp from 'sharp'
import { startConfiguredFinder, startFinderAtLaunch } from '../src/main/air-finder/host'
import { fixtureService } from './support/finder-service'
// @ts-expect-error Existing E2E fixture uses plain JavaScript.
import { makeFinderFixture, SHOWN_SLIDE, OTHER_SLIDE, SHOWN_WELL } from '../e2e/support/finder-fixture.mjs'

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

test('starts only from private launch configuration and refuses a changed library root', async () => {
  const root = await mkdtemp('/tmp/swa.')
  console.log('Finder socket scratch', root)
  const { scope } = await makeFinderFixture(root)
  const socketPath = join(root, 'finder.sock')
  const configPath = join(root, 'finder.json')
  const browserPort = 8870
  const config = JSON.stringify({ ...scope, socketPath, browserPort })
  await writeFile(configPath, config, { mode: 0o644 })
  let archive = scope.archiveRoot
  const roots = { archiveRoot: () => archive, wellRoot: () => scope.wellRoot }
  const pictures = { ready: () => true, query: async () => [] }
  await expect(startConfiguredFinder(configPath, roots, pictures)).rejects.toThrow('private file')
  await chmod(configPath, 0o600)
  const server = await startConfiguredFinder(configPath, roots, pictures)
  const local = (path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    request({ socketPath, path, headers: { Host: `127.0.0.1:${browserPort}` } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode!, body }))
    }).on('error', reject).end()
  })
  try {
    const occupiedPath = await realpath(socketPath)
    const { ino } = await lstat(occupiedPath)
    await expect(startConfiguredFinder(configPath, roots, pictures)).rejects.toHaveProperty('socketPath', occupiedPath)
    const warn = vi.fn()
    expect(await startFinderAtLaunch([`--air-finder-config=${configPath}`], roots, pictures, warn)).toBeNull()
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      `A connection file already exists at:\n${occupiedPath}\n\nIf another finder is running, quit it first. Move the file to the Bin only after checking that nothing is using it, then restart SlideWell.`
    )
    expect((await lstat(occupiedPath)).ino).toBe(ino)
    expect(JSON.parse((await local('/api/library')).body).meaning).toBe(false)
    const result = await local('/api/search?mode=words&q=lantern')
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body).items[0]).toMatchObject({ source: 'Amber Harbour · slide 1' })
    const item = JSON.parse(result.body).items.find((hit) => hit.corpusId === 'well')
    await truncate(join(scope.wellRoot, 'images', 'lantern-photo.png'), 21 * 1024 * 1024)
    expect((await local('/api/download/' + item.ref)).status).toBe(404)
    archive = join(root, 'different-archive')
    expect((await local('/api/search?mode=words&q=lantern')).status).toBe(503)
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() })
  }
})

test('warns only on an opted-in launch and keeps malformed private settings out of the warning', async () => {
  const root = await mkdtemp('/tmp/swa.')
  console.log('Finder settings scratch', root)
  const configPath = join(root, 'private-config.json')
  await writeFile(configPath, 'invented private settings', { mode: 0o600 })
  const roots = { archiveRoot: () => root, wellRoot: () => root }
  const pictures = { ready: () => false, query: async () => [] }
  const warn = vi.fn()
  expect(await startFinderAtLaunch([], roots, pictures, warn)).toBeNull()
  expect(warn).not.toHaveBeenCalled()
  expect(await startFinderAtLaunch([`--air-finder-config=${configPath}`], roots, pictures, warn)).toBeNull()
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    'SlideWell couldn’t read the Air finder settings. Check that the private settings file exists and contains valid JSON.'
  )
})

test('can finish a Word search while the review lock is released by the main loop', async () => {
  const host = await fixtureService()
  const review = new DatabaseSync(join(host.fixture.scope.wellRoot, 'triage.db'))
  let locked = false
  const unlock = () => {
    if (!locked) return
    review.exec('ROLLBACK')
    locked = false
  }
  try {
    expect((await host.request('/api/search?mode=words&q=lantern')).status).toBe(200)
    review.exec('BEGIN EXCLUSIVE')
    locked = true
    const search = host.request('/api/search?mode=words&q=lantern')
    const release = setTimeout(unlock, 150)
    try {
      const result = await search
      expect(result.status).toBe(200)
      expect((await result.json()).items.map((item) => item.itemId)).toContain(`well:${SHOWN_WELL}`)
    } finally {
      clearTimeout(release)
    }
  } finally {
    unlock()
    review.close()
    await host.close()
  }
})

test('reuses a verified preview across searches and refuses it after the file is replaced', async () => {
  const host = await fixtureService()
  const resize = vi.spyOn(sharp.prototype, 'resize')
  try {
    const findPreview = async () => {
      const { items } = await (await host.request('/api/search?mode=words&q=lantern')).json()
      return '/api/preview/' + items.find((item) => item.itemId === `well:${SHOWN_WELL}`).ref
    }
    const original = await findPreview()
    const first = await host.request(original)
    expect(first.status).toBe(200)
    expect(first.headers.get('cache-control')).toBe('no-store')
    const bytes = Buffer.from(await first.arrayBuffer())
    const repeated = await findPreview()
    expect(repeated).not.toBe(original)
    const again = await host.request(repeated)
    expect(again.status).toBe(200)
    expect(Buffer.from(await again.arrayBuffer())).toEqual(bytes)
    expect(resize).toHaveBeenCalledTimes(1)

    const file = join(host.fixture.scope.wellRoot, 'images', 'lantern-photo.png')
    const replacement = file + '.next'
    await sharp({ create: { width: 720, height: 414, channels: 3, background: '#265686' } }).png().toFile(replacement)
    await rename(replacement, file)
    expect((await host.request(repeated)).status).toBe(404)
    const fresh = await host.request(await findPreview())
    expect(fresh.status).toBe(200)
    expect(Buffer.from(await fresh.arrayBuffer())).not.toEqual(bytes)
    expect(resize).toHaveBeenCalledTimes(2)
  } finally {
    resize.mockRestore()
    await host.close()
  }
})
