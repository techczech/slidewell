/**
 * "More like this" in the inspector: from the ranked neighbours of one item, keep the ones worth
 * showing. Pure, no I/O. The item itself never appears, and neither does any other slide of the same
 * presentation (those are already in the inspector's "other slides in this presentation" strip);
 * well images have no presentation, so only the item itself is dropped for them.
 */
import { NotIndexedError, type Scored } from './picture-search/engine'
import { matchScore, type MatchScore } from './match-bands'
import { rowIds, type MatchRow } from './matched-search'

export const MORE_LIKE_THIS_SHOWN = 6

/** `slide:<presentation id>#<order>` -> the presentation id; any other id -> null. */
export function presentationOf(id: string): string | null {
  const m = id.match(/^slide:(.+)#\d+$/)
  return m ? m[1] : null
}

/** Best-first, self and same-presentation slides removed, duplicates removed, at most `limit`. */
export function moreLikeThis(scored: Scored[], selfId: string, limit: number = MORE_LIKE_THIS_SHOWN): Scored[] {
  const selfPresentation = presentationOf(selfId)
  const seen = new Set<string>()
  const out: Scored[] = []
  for (const s of [...scored].sort((a, b) => b.score - a.score)) {
    if (out.length >= limit) break
    if (s.id === selfId || seen.has(s.id)) continue
    if (selfPresentation !== null && presentationOf(s.id) === selfPresentation) continue
    seen.add(s.id)
    out.push(s)
  }
  return out
}

// --- the run: model check, query, exclusion, resolve --------------------------------------------


export type MoreLikeThisState = 'ok' | 'no-model' | 'not-indexed' | 'none' | 'error'
export type MoreLikeThisResult<R> = { state: MoreLikeThisState; items: R[]; error?: string }

export type MoreLikeThisDeps<R> = {
  modelReady: () => boolean
  query: (imageId: string, opts: { limit: number; kinds: Array<'slide' | 'well-image'> }) => Promise<Scored[]>
  /** Ids to wire rows; ids that no longer exist are dropped. */
  resolve: (ids: string[]) => Promise<Map<string, R>>
}

/** Neighbours fetched before the exclusions: room for a presentation whose own slides crowd the top. */
const FETCH = 150

/**
 * Six most similar items for one inspector item (a result row). Needs the model downloaded (the
 * button is disabled without it); an item with no stored vector gives 'not-indexed', not an error.
 */
export async function runMoreLikeThis<R extends { score?: MatchScore }>(deps: MoreLikeThisDeps<R>, row: MatchRow): Promise<MoreLikeThisResult<R>> {
  if (!deps.modelReady()) return { state: 'no-model', items: [] }
  const selfId = rowIds(row)[0]
  if (!selfId) return { state: 'not-indexed', items: [] }
  let scored: Scored[]
  try {
    scored = await deps.query(selfId, { limit: FETCH, kinds: ['slide', 'well-image'] })
  } catch (e) {
    if (e instanceof NotIndexedError) return { state: 'not-indexed', items: [] }
    return { state: 'error', items: [], error: (e as Error)?.message ?? String(e) }
  }
  const candidates = moreLikeThis(scored, selfId, MORE_LIKE_THIS_SHOWN * 4)
  const resolved = await deps.resolve(candidates.map((c) => c.id))
  const items: R[] = []
  for (const c of candidates) {
    const r = resolved.get(c.id)
    if (r) items.push({ ...r, score: matchScore('meaning', c.score) })
    if (items.length >= MORE_LIKE_THIS_SHOWN) break
  }
  return { state: items.length ? 'ok' : 'none', items }
}
