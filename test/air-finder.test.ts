import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, symlink, truncate, writeFile } from 'node:fs/promises'
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

test('finds, previews and downloads approved decks with filesystem names through the private socket', async () => {
  const root = await mkdtemp('/tmp/swa.')
  console.log('Finder deck name scratch', root)
  const parent = join(root, 'archive-parent')
  const linkedParent = join(root, 'archive-parent-link')
  const { scope } = await makeFinderFixture(parent)
  await symlink(parent, linkedParent)
  const extracted = join(scope.archiveRoot, 'extracted')
  const render = 'slide_0001.webp'
  const original = join(extracted, 'fixture-deck-1', 'renders', render)
  const decks = ['Coastal survey', 'Café', "Mariner's log", 'Wind & waves', '灯台調査', 'a'.repeat(200), 'Charts #2? 100%']
  // macOS can open the same directory under either Unicode spelling while retaining the on-disk name.
  const folderNames = new Map<string, string>()
  if (process.platform === 'darwin') {
    const composed = 'Žluťoučký'
    decks.push(composed.normalize('NFD'))
    folderNames.set('Café', 'Café'.normalize('NFD'))
    folderNames.set(composed.normalize('NFD'), composed)
  }
  const alias = 'Mapped coast'
  const outside = join(root, 'outside-deck')
  await mkdir(join(outside, 'renders'), { recursive: true })
  await copyFile(original, join(outside, 'renders', render))
  await symlink(outside, join(extracted, 'outside-link'))
  await writeFile(join(extracted, 'not-a-directory'), 'fixture')
  await symlink(join(extracted, decks[0]), join(extracted, alias))

  const db = new DatabaseSync(join(scope.archiveRoot, 'registry', 'slides.db'))
  try {
    for (const [index, name] of [...decks, alias, 'outside-link', 'not-a-directory', 'missing-deck'].entries()) {
      if (decks.includes(name)) {
        const renders = join(extracted, folderNames.get(name) ?? name, 'renders')
        await mkdir(renders, { recursive: true })
        await copyFile(original, join(renders, render))
      }
      const hash = `named-fixture-${index}`
      const row = db.prepare('INSERT INTO slides VALUES (?, ?, ?)').run(hash, name, 'navigationfixture')
      db.prepare("INSERT INTO slide_locations VALUES (?, ?, 1, 'content')").run(hash, name)
      db.prepare('INSERT INTO slides_fts (rowid, title, text_content) VALUES (?, ?, ?)').run(row.lastInsertRowid, name, 'navigationfixture')
    }
  } finally {
    db.close()
  }
  const entries = await readdir(extracted)
  for (const [id, folder] of folderNames) {
    expect(entries).toContain(folder)
    expect(entries).not.toContain(id)
  }

  const socketPath = join(root, 'finder.sock')
  const configPath = join(root, 'finder.json')
  const browserPort = 8870
  const config = { ...scope, socketPath, browserPort, presentations: [...decks, alias, 'outside-link', 'not-a-directory', 'missing-deck'] }
  const configure = (presentations: string[]) => writeFile(configPath, JSON.stringify({ ...config, presentations }), { mode: 0o600 })
  const roots = { archiveRoot: () => join(linkedParent, 'archive'), wellRoot: () => scope.wellRoot }
  const pictures = { ready: () => false, query: async () => [] }
  for (const invalid of ['..', '../outside-deck', outside, '.hidden-deck']) {
    await configure([...config.presentations, invalid])
    await expect(startConfiguredFinder(configPath, roots, pictures)).rejects.toThrow('settings are invalid')
  }
  await configure(config.presentations)
  const server = await startConfiguredFinder(configPath, roots, pictures)
  const local = (path: string) => new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    request({ socketPath, path, headers: { Host: `127.0.0.1:${browserPort}` } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }))
    }).on('error', reject).end()
  })
  const search = async (q: string): Promise<Array<{ itemId: string; ref: string; source: string }>> => {
    const result = await local('/api/search?' + new URLSearchParams({ mode: 'words', q }))
    expect(result.status).toBe(200)
    return JSON.parse(result.body.toString()).items
  }
  try {
    const listed = await search('navigationfixture')
    expect(listed.map(({ itemId }) => itemId).sort()).toEqual(decks.map((name) => `slide:${name}#1`).sort())
    expect(await search(alias)).toEqual([])
    const expectedBytes = await readFile(original)
    const sha256 = createHash('sha256').update(expectedBytes).digest('hex')
    for (const name of decks) {
      const result = (await search(name)).find(({ itemId }) => itemId === `slide:${name}#1`)
      expect(result?.source).toBe(`${name} · slide 1`)
      const preview = await local(`/api/preview/${result!.ref}`)
      expect(preview.status).toBe(200)
      expect((await sharp(preview.body).metadata()).width).toBe(480)
      const download = await local(`/api/download/${result!.ref}`)
      expect(download.status).toBe(200)
      expect(download.headers['x-slidewell-sha256']).toBe(sha256)
      expect(download.headers['content-disposition']).toBe(`attachment; filename="slidewell-${sha256.slice(0, 12)}.webp"`)
      expect(download.body).toEqual(expectedBytes)
    }
    const ref = listed.find(({ itemId }) => itemId === `slide:${decks[0]}#1`)!.ref
    const previewPath = `/api/preview/${ref}`
    expect((await local(previewPath)).status).toBe(200)
    const deck = join(extracted, decks[0])
    await rename(deck, join(extracted, 'relocated-coast'))
    await symlink(outside, deck)
    expect((await local(previewPath)).status).toBe(404)
    expect((await local(`/api/download/${ref}`)).status).toBe(404)
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() })
  }
}, 30_000)

test('refuses an alias to an unlisted deck with a cold or cached preview', async () => {
  const host = await fixtureService()
  const extracted = join(host.fixture.scope.archiveRoot, 'extracted')
  const deck = join(extracted, 'fixture-deck-1')
  // Move the directory intact so the render keeps its inode and revision.
  const unlisted = join(extracted, 'unlisted-deck')
  const stagedAlias = join(extracted, 'staged-alias')
  const search = async (): Promise<Array<{ itemId: string; ref: string }>> => {
    const response = await host.request('/api/search?' + new URLSearchParams({ mode: 'words', q: 'Lantern survey 1.1' }))
    expect(response.status).toBe(200)
    return (await response.json()).items
  }
  const refForDeck = async () => {
    const [item] = await search()
    expect(item?.itemId).toBe(SHOWN_SLIDE)
    return item.ref
  }
  const expectRefused = async (ref: string) => {
    expect(await search()).toEqual([])
    expect((await host.request(`/api/preview/${ref}`)).status).toBe(404)
    expect((await host.request(`/api/download/${ref}`)).status).toBe(404)
  }
  try {
    const coldRef = await refForDeck()
    await rename(deck, unlisted)
    await symlink(unlisted, deck)
    await expectRefused(coldRef)

    await rename(deck, stagedAlias)
    await rename(unlisted, deck)
    const cachedRef = await refForDeck()
    expect((await host.request(`/api/preview/${cachedRef}`)).status).toBe(200)
    await rename(deck, unlisted)
    await rename(stagedAlias, deck)
    await expectRefused(cachedRef)
  } finally {
    await host.close()
  }
}, 30_000)

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

test('keeps library status and search available during a full PNG preview burst', async () => {
  const measure = process.env.SLIDEWELL_FINDER_BENCHMARK === '1'
  const width = measure ? 8_000 : 600
  const host = await fixtureService(async ({ scope }: { scope: { wellRoot: string; wellImages: string[] } }) => {
    const original = join(scope.wellRoot, 'images', 'burst.png')
    await sharp({ create: { width, height: measure ? 5_000 : 400, channels: 3, background: '#315979' } })
      .png().toFile(original)
    const db = new DatabaseSync(join(scope.wellRoot, 'well.db'))
    try {
      const add = db.prepare('INSERT INTO well_fts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      for (let index = 0; index < 6; index++) {
        const id = 'd0000000000' + index
        const rel = `images/burst-${index}.png`
        await copyFile(original, join(scope.wellRoot, rel))
        add.run(id, 'burst-' + index, 'png', rel, 'well', 'screenshot', '', '', 'stormsignal', '2025-04-10')
        scope.wellImages.push(id)
      }
    } finally { db.close() }
  })
  // Hold the first decode only in the regression check, so the six requests
  // occupy the preview queue regardless of machine speed.
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const originalMetadata = sharp.prototype.metadata
  const metadata = measure ? undefined : vi.spyOn(sharp.prototype, 'metadata').mockImplementation(async function (this: sharp.Sharp) {
    await gate
    return originalMetadata.call(this)
  })
  try {
    const { items } = await (await host.request('/api/search?mode=words&q=stormsignal')).json()
    expect(items).toHaveLength(6)
    let arrived = 0
    const admitted = new Promise<void>(resolve => {
      host.server.on('request', req => {
        if (req.url?.startsWith('/api/preview/') && ++arrived === items.length) resolve()
      })
    })
    const started = performance.now()
    const previews = Promise.all(items.map(async (item: { ref: string }) => {
      const response = await host.request('/api/preview/' + item.ref)
      await response.arrayBuffer()
      return response.status
    }))
    await admitted
    const searchStarted = performance.now()
    let library
    let search
    try {
      library = await host.request('/api/library')
      search = await host.request('/api/search?mode=words&q=lantern')
    } finally { release() }
    const searchMs = performance.now() - searchStarted
    const statuses = await previews
    if (measure) console.log(JSON.stringify({
      pngs: statuses, library: library.status, search: search.status,
      searchMs: Math.round(searchMs * 10) / 10, totalMs: Math.round(performance.now() - started)
    }))
    expect(statuses).toEqual(Array(6).fill(200))
    expect(library.status).toBe(200)
    expect(search.status).toBe(200)
    expect((await search.json()).items.map((item: { itemId: string }) => item.itemId)).toContain(SHOWN_SLIDE)
  } finally {
    release()
    metadata?.mockRestore()
    await host.close()
  }
})
