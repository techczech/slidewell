/**
 * Search with the Match switch (Words / Meaning / Both). Runs the word search, runs a picture query
 * only when the mode needs one, and hands both to the pure merge (match-bands.ts). The stores and the
 * picture engine come in as `deps`, so this file has no Electron or disk access of its own.
 *
 * Words mode never reaches `deps.pictureQuery`: that is the fast path. The same holds when there is
 * no free text to embed, when the model is not downloaded, and when the filters leave no picture
 * source (Presentations, Talks).
 */
import { parseQuery } from './searchlib'
import { planSources, type FromFilter, type KindFilter } from './searchfilters'
import { DEFAULT_MATCH, interleave, mergeBands, wordScore, type MatchMode, type MatchScore } from './match-bands'
import type { Scored } from './picture-search/engine'

/** The wire row fields this module reads and writes (a subset of the renderer's SlideResult). */
export type MatchRow = { kind: string; deck: string; slideOrder: number | null; reference: string; score?: MatchScore }
export type MatchCluster = { representative: MatchRow; members: MatchRow[]; size: number; deckCount: number }

export type MatchFilters = { type?: 'slides' | 'images' | 'decks'; from?: FromFilter; kind?: KindFilter }

export type MatchDeps = {
  /** The existing word search over every store the filters ask for. */
  words: (query: string) => Promise<MatchCluster[]>
  /** Model downloaded and verified. */
  modelReady: () => boolean
  pictureQuery: (text: string, opts: { limit: number; kinds: Array<'slide' | 'well-image'> }) => Promise<Scored[]>
  /** Picture ids to filtered result rows, as size-1 clusters; ids that fail the filters or no longer exist are dropped. */
  resolve: (ids: string[]) => Promise<Map<string, MatchCluster>>
}

export type MatchedResult = {
  requested: MatchMode
  /** What actually ran: 'words' when the model is missing, the query is empty or the picture query failed. */
  mode: MatchMode
  modelReady: boolean
  words: MatchCluster[]
  related: MatchCluster[]
  /** Picture query failure message, shown nowhere but kept for the status line. */
  pictureError: string | null
  ms: { words: number; meaning: number | null }
}

const PICTURE_FETCH = 150
export const RELATED_CAP = 40

/** The picture-search ids a word row stands for: its own and its cluster members'. */
export function rowIds(row: MatchRow): string[] {
  if (row.kind === 'slide' && row.slideOrder !== null && row.deck) return [`slide:${row.deck}#${row.slideOrder}`]
  // an OCR'd slide render: its slide_order is the page minus one, and page == extractor order
  if (row.kind === 'ocr-render' && row.slideOrder !== null && row.deck) return [`slide:${row.deck}#${row.slideOrder + 1}`]
  if (row.kind === 'well-image') {
    const m = row.reference.match(/img-([0-9a-f]+)/i)
    if (m) return [`well:${m[1]}`]
  }
  return []
}

/** Word rows arrive store by store (slides, then images, then the well): score each store's list on its own, then interleave. */
export function byStore(rows: MatchCluster[]): Array<{ item: MatchCluster; score: number }> {
  const family = (r: MatchRow): string => (r.kind === 'well-image' ? 'well' : r.kind === 'archive-image' || r.kind === 'ocr-image' ? 'images' : 'slides')
  const lists = new Map<string, MatchCluster[]>()
  for (const c of rows) {
    const k = family(c.representative)
    lists.set(k, [...(lists.get(k) ?? []), c])
  }
  const scored = [...lists.values()].map((l) => l.map((item, i) => ({ item, score: wordScore(i, l.length) })))
  return interleave(scored)
}

export function clusterIds(c: MatchCluster): string[] {
  return [...new Set([c.representative, ...c.members].flatMap(rowIds))]
}

export async function matchedSearch(deps: MatchDeps, query: string, filters: MatchFilters, requested: MatchMode = DEFAULT_MATCH): Promise<MatchedResult> {
  const modelReady = deps.modelReady()
  const text = parseQuery(query ?? '').text.trim()
  const plan = planSources(filters.type ?? 'slides', filters.from ?? 'all', filters.kind ?? 'all')
  const kinds: Array<'slide' | 'well-image'> = []
  if (plan.slides) kinds.push('slide')
  if (plan.well) kinds.push('well-image')
  const wantsPictures = requested !== 'words' && modelReady && text.length >= 2 && kinds.length > 0 && filters.type !== 'decks'

  let effective: MatchMode = wantsPictures ? requested : 'words'
  let pictureError: string | null = null
  let pics: Scored[] = []
  let meaningMs: number | null = null
  // 'meaning' alone needs no word search at all
  const t0 = Date.now()
  const wordRows = effective === 'meaning' ? [] : await deps.words(query)
  const wordsMs = Date.now() - t0
  if (effective !== 'words') {
    const t1 = Date.now()
    try {
      pics = await deps.pictureQuery(text, { limit: PICTURE_FETCH, kinds })
      meaningMs = Date.now() - t1
    } catch (e) {
      pictureError = (e as Error)?.message ?? String(e)
      effective = 'words' // the picture side failed: words still work
    }
    if (effective === 'words' && requested === 'meaning') {
      // meaning was asked for alone and failed: give the word results rather than nothing
      return { requested, mode: 'words', modelReady, words: await deps.words(query), related: [], pictureError, ms: { words: Date.now() - t0, meaning: null } }
    }
  }

  const merged = mergeBands(
    byStore(wordRows).map(({ item, score }) => ({ item, score, ids: clusterIds(item) })),
    effective === 'words' ? [] : pics,
    effective
  )
  const words = merged.words.map(({ item, score }) => ({ ...item, representative: { ...item.representative, score } }))

  const related: MatchCluster[] = []
  if (merged.related.length) {
    const resolved = await deps.resolve(merged.related.map((r) => r.id))
    for (const r of merged.related) {
      const c = resolved.get(r.id)
      if (c) related.push({ ...c, representative: { ...c.representative, score: r.score } })
      if (related.length >= RELATED_CAP) break
    }
  }
  return { requested, mode: effective, modelReady, words, related, pictureError, ms: { words: wordsMs, meaning: meaningMs } }
}
