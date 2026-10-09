import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PictureSearchEngine, normalise, rank, type Embedder } from '../src/main/picture-search/engine'
import { planQueue } from '../src/main/picture-search/progress'
import { VectorStore, canonicalRoot, slideId, wellImageId, type IndexItem } from '../src/main/picture-search/vector-store'

// A tiny fake embedder: 4 "concepts"; an image's file name and a query's words say which are present.
const CONCEPTS = ['robot', 'classroom', 'beach', 'chart']
const vec = (words: string): Float32Array => normalise(Float32Array.from(CONCEPTS, (c) => (words.includes(c) ? 1 : 0.05)))
const fake: Embedder = {
  embedText: async (t) => vec(t),
  embedImage: async (p) => vec(p)
}

const A = '/Volumes/Data/A'
const item = (id: string, path: string, kind: IndexItem['kind'] = 'slide', root = A): IndexItem => ({ id, kind, path, size: 10, mtimeMs: 1, ...(kind === 'slide' ? { root } : {}) })

let dir: string
let store: VectorStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-pic-'))
  store = new VectorStore(join(dir, 'picture-search.db'), { model: 'fake', dim: '4' })
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

async function seed(engine: PictureSearchEngine): Promise<void> {
  await engine.embedAndStore(item(slideId('AI tools', 1), '/Volumes/Data/robot-classroom.webp'))
  await engine.embedAndStore(item(slideId('Seals', 4), '/Volumes/Data/beach.webp'))
  await engine.embedAndStore(item(slideId('Budget', 2), '/Volumes/Data/chart.webp'))
  await engine.embedAndStore(item(wellImageId('ab12cd3'), '/Volumes/Data/robot.png', 'well-image'))
}

describe('picture-search engine (embed text, embed image, nearest neighbours)', () => {
  it('ranks stored images against a text query, best first, with cosine scores', async () => {
    const engine = new PictureSearchEngine(store, () => fake)
    await seed(engine)
    const r = await engine.pictureQuery({ text: 'robots in a classroom' }, { limit: 3 })
    expect(r.map((x) => x.id)).toEqual(['slide:AI tools#1', 'well:ab12cd3', expect.any(String)])
    expect(r[0].score).toBeGreaterThan(r[1].score)
    expect(r[0].score).toBeLessThanOrEqual(1.000001)
  })

  it('finds images similar to a stored image, excluding itself, without the model', async () => {
    const engine = new PictureSearchEngine(store, () => fake)
    await seed(engine)
    const noModel = new PictureSearchEngine(store, () => null)
    const r = await noModel.pictureQuery({ imageId: 'well:ab12cd3' }, { limit: 2 })
    expect(r[0].id).toBe('slide:AI tools#1')
    expect(r.some((x) => x.id === 'well:ab12cd3')).toBe(false)
    await expect(noModel.pictureQuery({ text: 'beach' })).rejects.toThrow(/not ready/)
    await expect(noModel.pictureQuery({ imageId: 'slide:nope#1' })).rejects.toThrow(/no picture-search vector/)
  })

  it('filters by kind and survives reopening the store (vectors are on disk)', async () => {
    await seed(new PictureSearchEngine(store, () => fake))
    store.close()
    store = new VectorStore(join(dir, 'picture-search.db'))
    expect(store.count()).toBe(4)
    expect(store.meta().model).toBe('fake')
    const engine = new PictureSearchEngine(store, () => fake)
    const r = await engine.pictureQuery({ text: 'robot' }, { kinds: ['well-image'] })
    expect(r.map((x) => x.id)).toEqual(['well:ab12cd3'])
    const v = store.get('slide:Seals#4')!.vector
    expect(Array.from(v)).toEqual(Array.from(vec('beach')))
  })

  it('an image that changes into something unreadable loses its old vector (store and memory)', async () => {
    const engine = new PictureSearchEngine(store, () => fake)
    await seed(engine)
    expect((await engine.pictureQuery({ text: 'beach' }, { limit: 1 }))[0].id).toBe('slide:Seals#4')
    const changed = { ...item(slideId('Seals', 4), '/Volumes/Data/beach.webp'), size: 99, mtimeMs: 2 }
    store.putFailure(changed, 'cannot read image')
    engine.forget(changed.id)
    expect(store.get(changed.id)).toBeNull()
    expect(store.fingerprints().get(changed.id)).toEqual({ path: '/Volumes/Data/beach.webp', size: 99, mtimeMs: 2 })
    expect((await engine.pictureQuery({ text: 'beach' })).some((r) => r.id === changed.id)).toBe(false)
    // once readable again (changed again), it is embedded and the failure cleared
    await engine.embedAndStore({ ...changed, size: 100, mtimeMs: 3 })
    expect(store.failedCount()).toBe(0)
    expect(store.get(changed.id)).not.toBeNull()
  })

  it('switching archive drops the old archive slide rows (well rows stay); resume compares paths', async () => {
    const engine = new PictureSearchEngine(store, () => fake)
    expect(store.useArchiveRoot('/Volumes/Data/A')).toEqual([]) // first root is adopted
    await seed(engine)
    store.putFailure(item(slideId('Broken', 1), '/Volumes/Data/A/broken.webp'), 'cannot read image')
    expect(store.useArchiveRoot('/Volumes/Data/A')).toEqual([]) // same root: nothing dropped
    const dropped = store.useArchiveRoot('/Volumes/Data/B')
    expect(dropped.sort()).toEqual(['slide:AI tools#1', 'slide:Budget#2', 'slide:Seals#4'])
    dropped.forEach((id) => engine.forget(id))
    expect(store.count()).toBe(1)
    expect(store.failedCount()).toBe(0)
    expect((await engine.pictureQuery({ text: 'robots in a classroom' })).map((r) => r.id)).toEqual(['well:ab12cd3'])
    expect(store.meta().slide_archive_root).toBe('/Volumes/Data/B')
    // same id, size and mtime but another path is not "already done"
    const a = item(slideId('Talk', 1), '/Volumes/Data/B/old/extracted/Talk/renders/slide_0001.webp', 'slide', '/Volumes/Data/B')
    await engine.embedAndStore(a)
    const b = { ...a, path: '/Volumes/Data/B/new/extracted/Talk/renders/slide_0001.webp' }
    expect(planQueue([b], store.fingerprints()).todo.map((i) => i.path)).toEqual([b.path])
    expect(planQueue([a], store.fingerprints()).todo).toEqual([])
  })

  it('an embed that finishes after an archive switch is not written (store or memory)', async () => {
    let release: () => void = () => undefined
    const slow: Embedder = { embedText: fake.embedText, embedImage: (p) => new Promise((r) => (release = () => r(vec(p)))) }
    const engine = new PictureSearchEngine(store, () => slow)
    store.useArchiveRoot(A)
    await engine.pictureQuery({ imageId: 'x' }).catch(() => undefined) // load the in-memory copy
    const inFlight = engine.embedAndStore(item(slideId('AI tools', 1), '/Volumes/Data/A/robot-classroom.webp'))
    await new Promise((r) => setTimeout(r, 5))
    store.useArchiveRoot('/Volumes/Data/B') // the user switches archive mid-call
    release()
    await inFlight
    expect(store.get('slide:AI tools#1')).toBeNull()
    expect(store.count()).toBe(0)
    await expect(engine.pictureQuery({ imageId: 'slide:AI tools#1' })).rejects.toThrow(/no picture-search vector/)
    // a failure recorded for an old-archive slide is refused the same way; well images are unaffected
    expect(store.putFailure(item(slideId('Old', 2), '/Volumes/Data/A/bad.webp'), 'cannot read image')).toBe(false)
    expect(store.put(item(wellImageId('ab12cd3'), '/Volumes/Data/robot.png', 'well-image'), vec('robot'))).toBe(true)
  })

  it('slide rows with no recorded root are dropped when a root is first recorded', async () => {
    await seed(new PictureSearchEngine(store, () => fake)) // written before any root was recorded
    store.putFailure(item(slideId('Broken', 1), '/Volumes/Data/A/broken.webp'), 'cannot read image')
    const dropped = store.useArchiveRoot(A)
    expect(dropped.sort()).toEqual(['slide:AI tools#1', 'slide:Budget#2', 'slide:Seals#4'])
    expect(store.count()).toBe(1) // the well image stays
    expect(store.failedCount()).toBe(0)
    expect(store.meta().slide_archive_root).toBe(A)
  })

  it('other spellings of the same archive folder (trailing slash, symlink) keep the index', async () => {
    const real = join(dir, 'archive')
    mkdirSync(real)
    symlinkSync(real, join(dir, 'link'))
    const canon = canonicalRoot(real)!
    expect(canonicalRoot(`${real}/`)).toBe(canon)
    expect(canonicalRoot(join(dir, 'link'))).toBe(canon)
    expect(canonicalRoot(join(dir, 'missing'))).toBeNull() // unavailable: callers drop nothing
    store.useArchiveRoot(canon)
    const engine = new PictureSearchEngine(store, () => fake)
    await engine.embedAndStore(item(slideId('AI tools', 1), join(canon, 'robot-classroom.webp'), 'slide', canon))
    expect(store.useArchiveRoot(canonicalRoot(`${real}/`)!)).toEqual([])
    expect(store.useArchiveRoot(canonicalRoot(join(dir, 'link'))!)).toEqual([])
    expect(store.count()).toBe(1)
  })

  it('rank keeps the true top-k under partial selection', () => {
    const q = normalise(Float32Array.from([1, 0]))
    const items = Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, kind: 'slide' as const, vector: normalise(Float32Array.from([i, 50 - i])) }))
    expect(rank(q, items, 3).map((x) => x.id)).toEqual(['i49', 'i48', 'i47'])
  })
})
