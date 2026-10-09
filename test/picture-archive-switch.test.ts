import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ImageEnumerator } from '../src/main/picture-search/enumeration'
import { Indexer } from '../src/main/picture-search/indexer'
import { PictureSearchEngine, UnreadableImageError, normalise, type Embedder } from '../src/main/picture-search/engine'
import { VectorStore, canonicalRoot, slideId, type IndexItem } from '../src/main/picture-search/vector-store'

const fake: Embedder = { embedText: async () => normalise(Float32Array.from([1, 0])), embedImage: async () => normalise(Float32Array.from([1, 1])) }
const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
  let resolve: (v: T) => void = () => undefined
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
const slides = (root: string, name: string, n: number): IndexItem[] =>
  Array.from({ length: n }, (_, i) => ({ id: slideId(name, i + 1), kind: 'slide' as const, path: join(root, name, `slide_${i + 1}.webp`), size: 10, mtimeMs: 1, root }))

let dir: string
let store: VectorStore
let A: string
let B: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-switch-'))
  mkdirSync(join(dir, 'A'))
  mkdirSync(join(dir, 'B'))
  A = canonicalRoot(join(dir, 'A'))!
  B = canonicalRoot(join(dir, 'B'))!
  store = new VectorStore(join(dir, 'picture-search.db'))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Store + engine + indexer wired as the service wires them; archive and well scans are controlled. */
function rig(scan: { archive: (root: string) => Promise<IndexItem[]>; well?: () => Promise<IndexItem[]> }, configured: { root: string }) {
  const engine = new PictureSearchEngine(store, () => fake)
  const images = new ImageEnumerator({
    archiveRoot: () => configured.root,
    bind: (canon) => store.useArchiveRoot(canon).forEach((id) => engine.forget(id)),
    archive: scan.archive,
    well: scan.well ?? (async () => [])
  })
  const progress: string[] = []
  const indexer = new Indexer({
    enumerate: async () => (await images.enumerate()).items,
    handled: () => store.fingerprints(),
    failedCount: () => store.failedCount(),
    embed: (item) => engine.embedAndStore(item),
    isItemFailure: (e) => e instanceof UnreadableImageError,
    recordFailure: (item, err) => (store.putFailure(item, err) ? 'stored' : 'stale'),
    onProgress: (p) => progress.push(`${p.phase} ${p.done}/${p.total}`),
    progressEveryMs: 0
  })
  return { engine, images, indexer, progress }
}

describe('archive switch while enumerating and indexing', () => {
  it("reviewer's sequence: A's slow estimate finishing during B's pass leaves B indexed and no A rows", async () => {
    const configured = { root: A }
    const scanA = deferred<IndexItem[]>()
    const wellB = deferred<IndexItem[]>()
    let wellCalls = 0
    const { images, indexer, progress } = rig(
      {
        archive: (root) => (root === A ? scanA.promise : Promise.resolve(slides(B, 'B-talk', 3))),
        well: () => (++wellCalls === 1 ? wellB.promise : Promise.resolve([])) // call 1 = B's pass
      },
      configured
    )
    const estimateA = images.enumerate() // Settings estimate for A: waits on A's render scan
    await new Promise((r) => setTimeout(r, 0))
    configured.root = B // the user picks archive B; indexing starts
    const pass = indexer.start() // B's pass: B's scan done, now waiting on the well scan
    await new Promise((r) => setTimeout(r, 0))
    scanA.resolve(slides(A, 'A-talk', 1)) // A's scan finishes in the middle of B's pass
    const est = await estimateA
    expect(est.root).toBe(A) // the estimate gets its own result…
    wellB.resolve([])
    await pass
    const all = store.all().map((v) => v.id).sort()
    expect(all).toEqual(['slide:B-talk#1', 'slide:B-talk#2', 'slide:B-talk#3']) // …and B's pass gets B's
    expect(store.meta().slide_archive_root).toBe(B)
    expect(indexer.state()).toMatchObject({ phase: 'done', done: 3, total: 3 })
    expect(progress.some((p) => p.endsWith('/1'))).toBe(false) // never reported A's count
    // and A's late scan did not poison the cache: B's next enumeration is still B
    expect((await images.enumerate()).items.map((i) => i.root)).toEqual([B, B, B])
  })

  it('a refused (stale) write is not counted: the pass stops and re-plans from the current archive', async () => {
    const configured = { root: A }
    let calls = 0
    const { indexer, progress } = rig(
      {
        archive: async (root) => {
          calls++
          if (calls === 1) {
            configured.root = B // switched after this pass was planned under A
            store.useArchiveRoot(B)
          }
          return slides(root, root === A ? 'A-talk' : 'B-talk', 2)
        }
      },
      configured
    )
    await indexer.start()
    expect(store.all().map((v) => v.id).sort()).toEqual(['slide:B-talk#1', 'slide:B-talk#2'])
    expect(indexer.state()).toMatchObject({ phase: 'done', done: 2, total: 2 })
    // A's pass starts at 0/2 and stops at the refused write without advancing; B's pass runs 0 → 2
    expect(progress).toEqual(['indexing 0/2', 'indexing 0/2', 'indexing 1/2', 'done 2/2', 'done 2/2'])
  })

  it('stops with an error instead of spinning when a fresh plan is refused again at once', async () => {
    const configured = { root: B }
    store.useArchiveRoot(B)
    let plans = 0
    const engine = new PictureSearchEngine(store, () => fake)
    const indexer = new Indexer({
      enumerate: async () => {
        plans++
        return slides(A, 'A-talk', 2) // always planned under the wrong root
      },
      handled: () => store.fingerprints(),
      failedCount: () => store.failedCount(),
      embed: (item) => engine.embedAndStore(item),
      isItemFailure: () => false,
      recordFailure: () => 'stale',
      onProgress: () => undefined,
      progressEveryMs: 0
    })
    void configured
    await indexer.start()
    expect(indexer.state().phase).toBe('error')
    expect(indexer.state().error).toMatch(/keeps changing/)
    expect(plans).toBe(2)
    expect(store.count()).toBe(0)
  })
})
