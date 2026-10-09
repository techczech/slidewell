/**
 * The main-process picture-search interface. Two operations over one embedding space:
 *   - embed (text → vector, image → vector) through an Embedder, and
 *   - nearest-neighbour ranking over every vector in the store.
 * `pictureQuery({ text })` ranks stored items against a text query; `pictureQuery({ imageId })`
 * ranks them against a stored item's own vector (no model needed). Both return ids with cosine
 * scores, best first. Vectors are L2-normalised, so cosine = dot product; brute force over ~62k
 * 768-d vectors takes tens of milliseconds, so no ANN index is needed at this size.
 */
import type { IndexItem, ItemKind, StoredVector, VectorStore } from './vector-store'

export interface Embedder {
  /** A search query (the query prompt is added by the embedder). L2-normalised. */
  embedText(text: string): Promise<Float32Array>
  /** An image file on disk. L2-normalised. */
  embedImage(path: string): Promise<Float32Array>
}

/** The image itself cannot be embedded (unreadable, too small, model output unusable). The indexer
 * records it and moves on; any other error means the engine failed and indexing stops instead. */
export class UnreadableImageError extends Error {}

export type Scored = { id: string; score: number }
/** 'stale': the store refused the write (a slide planned under an archive it is no longer bound to). */
export type WriteResult = 'stored' | 'stale'
export type PictureQuery = { text: string } | { imageId: string }
export type QueryOptions = { limit?: number; kinds?: ItemKind[] }

/** What a query ranks when it names no kinds: triage screenshots (sorter input) only on request. */
export const SEARCH_KINDS: ItemKind[] = ['slide', 'well-image']

export function normalise(v: Float32Array): Float32Array {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  const n = Math.sqrt(s) || 1
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n
  return out
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** Rank `items` by dot product with `q`, best first, keeping the top `limit` (partial selection). */
export function rank(q: Float32Array, items: Iterable<StoredVector>, limit: number, skipId?: string, kinds?: ItemKind[]): Scored[] {
  const top: Scored[] = []
  for (const it of items) {
    if (it.id === skipId) continue
    if (kinds && !kinds.includes(it.kind)) continue
    const score = dot(q, it.vector)
    if (top.length < limit) {
      top.push({ id: it.id, score })
      if (top.length === limit) top.sort((a, b) => b.score - a.score)
    } else if (score > top[top.length - 1].score) {
      let i = top.length - 1
      while (i > 0 && top[i - 1].score < score) i--
      top.splice(i, 0, { id: it.id, score })
      top.pop()
    }
  }
  return top.length < limit ? top.sort((a, b) => b.score - a.score) : top
}

export class PictureSearchEngine {
  private cache: Map<string, StoredVector> | null = null

  constructor(
    private store: VectorStore,
    private embedder: () => Embedder | null
  ) {}

  private vectors(): Map<string, StoredVector> {
    if (!this.cache) this.cache = new Map(this.store.all().map((v) => [v.id, v]))
    return this.cache
  }

  /** The one query function: text → ranked ids, or a stored image id → similar ids. */
  async pictureQuery(q: PictureQuery, opts: QueryOptions = {}): Promise<Scored[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 5000))
    if ('imageId' in q) {
      const self = this.vectors().get(q.imageId) ?? this.store.get(q.imageId)
      if (!self) throw new Error(`no picture-search vector for ${q.imageId}`)
      return rank(self.vector, this.vectors().values(), limit, q.imageId, opts.kinds ?? SEARCH_KINDS)
    }
    const text = q.text.trim()
    if (!text) return []
    const e = this.embedder()
    if (!e) throw new Error('picture search model is not ready')
    const qv = await e.embedText(text)
    return rank(qv, this.vectors().values(), limit, undefined, opts.kinds ?? SEARCH_KINDS)
  }

  /** Embed one image and store its vector (the indexer's unit of work). A refused write is 'stale'. */
  async embedAndStore(item: IndexItem): Promise<WriteResult> {
    const e = this.embedder()
    if (!e) throw new Error('picture search model is not ready')
    const v = await e.embedImage(item.path)
    // the store refuses a slide planned under an archive root it is no longer bound to
    if (!this.store.put(item, v)) return 'stale'
    this.cache?.set(item.id, { id: item.id, kind: item.kind, vector: v })
    return 'stored'
  }

  /** Drop one id from the in-memory copy (its vector was removed from the store). */
  forget(id: string): void {
    this.cache?.delete(id)
  }

  /** Forget the in-memory copy (after outside changes to the store). */
  invalidate(): void {
    this.cache = null
  }
}
