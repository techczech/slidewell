/**
 * Search results, grouped by appearance: the step between the text clusters (searchlib.clusterHits)
 * and the wire. For every result row that has an embedding, appearance REPLACES text grouping: text
 * clusters are split into their rows, the embedded rows are grouped by appearance (complete-link, so
 * the displayed tier holds for every pair in a card), and only rows with no embedding stay in text
 * clusters as the fallback. Pure over its deps (no Electron, no disk).
 *
 * Bounded: only the first `limit` embedded-candidate rows are grouped (the visible page plus
 * look-ahead), and vectors are requested for those ids only, so a long result list neither blocks the
 * main process nor loads the store. Rows beyond the cap stay in their text clusters.
 */
import { groupWithFingerprints, LOOK_ALIKE_THRESHOLDS, type LookAlikeItem, type LookAlikeThresholds, type Tier } from './groups'

export type ClusterShape<R> = { representative: R; members: R[]; size: number; deckCount: number }
export type LookAlikeTag = { lookAlike?: Tier }

/** First this many candidate rows are grouped; later ones stay as they are. ~25 ms worst case at 200, ~90 ms at 400. */
export const GROUP_LIMIT = 200

export type MergeDeps<R> = {
  /** The picture-search id a result row stands for, or null when it has none. */
  idOf: (row: R) => string | null
  /** Stored vectors for these ids (ids with none are left out). Called with at most `limit` ids. */
  vectorsOf: (ids: string[]) => Map<string, Float32Array>
  /** dHash for ids whose tier hinges on it; may return fewer (or none). */
  fingerprints?: (ids: string[]) => Promise<Map<string, bigint>>
}

type Entry<R, C> = { row: R; from: number; src: C }

export async function mergeLookAlikeClusters<R extends { deck: string }, C extends ClusterShape<R>>(
  clusters: C[],
  deps: MergeDeps<R>,
  opts: { limit?: number; thresholds?: LookAlikeThresholds } = {}
): Promise<Array<C & LookAlikeTag>> {
  const limit = opts.limit ?? GROUP_LIMIT
  // candidates in result order, capped BEFORE any vector is requested; an id counts once
  const candidates: Array<Entry<R, C> & { id: string }> = []
  const seen = new Set<string>()
  clusters.forEach((c, from) => {
    for (const row of c.members) {
      const id = deps.idOf(row)
      if (id === null || seen.has(id) || candidates.length >= limit) continue
      seen.add(id)
      candidates.push({ row, from, src: c, id })
    }
  })
  if (candidates.length < 2) return clusters
  const vectors = deps.vectorsOf(candidates.map((c) => c.id))
  const embedded = candidates.filter((c) => vectors.has(c.id))
  if (embedded.length < 2) return clusters
  const byId = new Map(embedded.map((e) => [e.id, e]))
  const items: LookAlikeItem[] = embedded.map((e) => ({ id: e.id, vector: vectors.get(e.id)! }))
  const groups = await groupWithFingerprints(items, deps.fingerprints ?? (async () => new Map()), opts.thresholds ?? LOOK_ALIKE_THRESHOLDS)

  const embeddedRows = new Set<R>(embedded.map((e) => e.row))
  const build = (src: C, members: R[], tier: Tier | null): C & LookAlikeTag => {
    const presentations = new Set(members.map((m) => m.deck).filter(Boolean))
    return { ...src, representative: members[0], members, size: members.length, deckCount: presentations.size, ...(tier ? { lookAlike: tier } : {}) }
  }
  // appearance cards, placed where their first row sat in the original order
  const cardsAt = new Map<number, Array<C & LookAlikeTag>>()
  for (const g of groups) {
    const es = g.ids.map((id) => byId.get(id)!)
    const card = build(es[0].src, es.map((e) => e.row), g.tier)
    cardsAt.set(es[0].from, [...(cardsAt.get(es[0].from) ?? []), card])
  }
  const out: Array<C & LookAlikeTag> = []
  clusters.forEach((c, i) => {
    out.push(...(cardsAt.get(i) ?? []))
    const rest = c.members.filter((m) => !embeddedRows.has(m))
    if (rest.length === c.members.length) out.push(c) // untouched: text clusters stay the fallback
    else if (rest.length) out.push(build(c, rest, null))
  })
  return out
}
