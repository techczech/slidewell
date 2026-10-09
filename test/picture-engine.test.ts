import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PictureSearchEngine, normalise, rank, type Embedder } from '../src/main/picture-search/engine'
import { VectorStore, slideId, wellImageId, type IndexItem } from '../src/main/picture-search/vector-store'

// A tiny fake embedder: 4 "concepts"; an image's file name and a query's words say which are present.
const CONCEPTS = ['robot', 'classroom', 'beach', 'chart']
const vec = (words: string): Float32Array => normalise(Float32Array.from(CONCEPTS, (c) => (words.includes(c) ? 1 : 0.05)))
const fake: Embedder = {
  embedText: async (t) => vec(t),
  embedImage: async (p) => vec(p)
}

const item = (id: string, path: string, kind: IndexItem['kind'] = 'slide'): IndexItem => ({ id, kind, path, size: 10, mtimeMs: 1 })

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
    expect(store.fingerprints().get(changed.id)).toEqual({ size: 99, mtimeMs: 2 })
    expect((await engine.pictureQuery({ text: 'beach' })).some((r) => r.id === changed.id)).toBe(false)
    // once readable again (changed again), it is embedded and the failure cleared
    await engine.embedAndStore({ ...changed, size: 100, mtimeMs: 3 })
    expect(store.failedCount()).toBe(0)
    expect(store.get(changed.id)).not.toBeNull()
  })

  it('rank keeps the true top-k under partial selection', () => {
    const q = normalise(Float32Array.from([1, 0]))
    const items = Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, kind: 'slide' as const, vector: normalise(Float32Array.from([i, 50 - i])) }))
    expect(rank(q, items, 3).map((x) => x.id)).toEqual(['i49', 'i48', 'i47'])
  })
})
