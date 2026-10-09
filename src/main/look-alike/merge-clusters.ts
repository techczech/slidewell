/**
 * Search results, grouped by appearance: the step between the text clusters (searchlib.clusterHits)
 * and the wire. Clusters whose representative picture looks like another's are merged into one
 * cluster ("N versions"); clusters with no embedding pass through untouched, so text-only grouping
 * remains the fallback. Pure over its deps (no Electron, no disk).
 *
 * Bounded: only the first `limit` embedded clusters are grouped (the visible page plus look-ahead);
 * the rest stay as they are, so grouping a long result list never blocks the main process. Grouping
 * is complete-link over cosine (groups.ts).
 */
import { groupWithFingerprints, LOOK_ALIKE_THRESHOLDS, type LookAlikeItem, type LookAlikeThresholds, type Tier } from './groups'

export type ClusterShape<R> = { representative: R; members: R[]; size: number; deckCount: number }
export type LookAlikeTag = { lookAlike?: Tier }

/** First this many embedded clusters are grouped; later ones are shown ungrouped. */
/** Worst case (nothing groups) is ~n^2/2 dot products: 200 items is ~25 ms, 400 is ~90 ms on this machine. */
export const GROUP_LIMIT = 200

export type MergeDeps<R> = {
  /** The picture-search id a result row stands for, or null when it has none. */
  idOf: (row: R) => string | null
  /** Stored vectors for these ids (ids with none are left out). */
  vectorsOf: (ids: string[]) => Map<string, Float32Array>
  /** dHash for ids whose tier hinges on it; may return fewer (or none). */
  fingerprints?: (ids: string[]) => Promise<Map<string, bigint>>
}

export async function mergeLookAlikeClusters<R extends { deck: string }, C extends ClusterShape<R>>(
  clusters: C[],
  deps: MergeDeps<R>,
  opts: { limit?: number; thresholds?: LookAlikeThresholds } = {}
): Promise<Array<C & LookAlikeTag>> {
  const limit = opts.limit ?? GROUP_LIMIT
  const ids = clusters.map((c) => deps.idOf(c.representative))
  const vectors = deps.vectorsOf(ids.filter((x): x is string => x !== null))
  // an id can head only one cluster here; a repeat (same picture listed twice) is left as it is
  const owner = new Map<string, number>()
  const items: LookAlikeItem[] = []
  clusters.forEach((_, i) => {
    const id = ids[i]
    if (id === null || !vectors.has(id) || owner.has(id) || items.length >= limit) return
    owner.set(id, i)
    items.push({ id, vector: vectors.get(id)! })
  })
  if (items.length < 2) return clusters
  const groups = await groupWithFingerprints(items, deps.fingerprints ?? (async () => new Map()), opts.thresholds ?? LOOK_ALIKE_THRESHOLDS)
  const absorbedBy = new Map<number, number>() // cluster index -> head index
  const headTier = new Map<number, Tier>()
  const absorbed = new Map<number, number[]>()
  for (const g of groups) {
    if (g.ids.length < 2 || g.tier === null) continue
    const head = owner.get(g.ids[0])!
    headTier.set(head, g.tier)
    absorbed.set(head, g.ids.slice(1).map((id) => owner.get(id)!))
    for (const id of g.ids.slice(1)) absorbedBy.set(owner.get(id)!, head)
  }
  const out: Array<C & LookAlikeTag> = []
  clusters.forEach((c, i) => {
    if (absorbedBy.has(i)) return
    const tier = headTier.get(i)
    if (!tier) {
      out.push(c)
      return
    }
    const members = [...c.members, ...absorbed.get(i)!.flatMap((k) => clusters[k].members)]
    const presentations = new Set(members.map((m) => m.deck).filter(Boolean))
    out.push({ ...c, members, size: members.length, deckCount: presentations.size, lookAlike: tier })
  })
  return out
}
