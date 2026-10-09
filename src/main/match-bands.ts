/**
 * The Match switch's merge-and-rank step (pure, no I/O). Word hits and picture hits go in; two
 * bands come out:
 *   - Words match: every word hit, in the order the word search gave, each with a words score.
 *   - Looks related: picture hits that are NOT already in the words band, best meaning score first.
 * An item in both lists therefore appears only in the Words band, and a picture hit never moves a
 * word hit. Meaning-only mode skips the words band and keeps every picture hit.
 *
 * Words score. SQLite FTS gives no 0-1 relevance (its bm25 values are corpus-relative and each
 * store, slides, images and the well, has its own scale), so the score comes from position: a word
 * list arrives best-first from its store, and the item at position i of n scores
 * 0.99 - 0.49 * i / (n - 1), so the first is 0.99 and the last 0.50 (a list of one scores 0.99).
 * When hits come from several stores each store is scored within its own list, then the stores are
 * interleaved by that score, so a store's only hit is not marked down for sitting beside another's.
 * Meaning scores are the cosine similarity as returned. Both print as `words 0.91` / `meaning 0.78`.
 */
import type { Scored } from './picture-search/engine'

export type MatchMode = 'words' | 'meaning' | 'both'
export const DEFAULT_MATCH: MatchMode = 'both'

export type ScoreKind = 'words' | 'meaning'
export type MatchScore = { kind: ScoreKind; value: number; label: string }

/** One consistent label form: kind, a space, the score to two decimals. */
export function scoreLabel(kind: ScoreKind, value: number): string {
  return `${kind} ${(Math.round(value * 100) / 100).toFixed(2)}`
}

export function matchScore(kind: ScoreKind, value: number): MatchScore {
  return { kind, value, label: scoreLabel(kind, value) }
}

/** Score for position `i` of `n` in a best-first word list (see the header). */
export function wordScore(i: number, n: number): number {
  if (n <= 1) return 0.99
  return 0.99 - (0.49 * i) / (n - 1)
}

/** A word hit with the picture-search ids it stands for (a cluster lists its representative and members). */
/** `score` (0-1) overrides the position score when the caller has scored the item within its own store. */
export type WordEntry<T> = { item: T; ids: string[]; score?: number }

export type Bands<T> = {
  words: Array<{ item: T; score: MatchScore }>
  related: Array<{ id: string; score: MatchScore }>
}

/**
 * `words` best-first per store. `pictures` ranked by cosine, best first (as pictureQuery returns).
 * `mode`: 'words' ignores pictures; 'meaning' returns only the picture list; 'both' returns two bands.
 */
export function mergeBands<T>(words: WordEntry<T>[], pictures: Scored[], mode: MatchMode = 'both'): Bands<T> {
  const related = (skip: Set<string>): Bands<T>['related'] => {
    const seen = new Set<string>()
    const out: Bands<T>['related'] = []
    for (const p of [...pictures].sort((a, b) => b.score - a.score)) {
      if (skip.has(p.id) || seen.has(p.id)) continue
      seen.add(p.id)
      out.push({ id: p.id, score: matchScore('meaning', p.score) })
    }
    return out
  }
  if (mode === 'words') return { words: scoreWords(words), related: [] }
  if (mode === 'meaning') return { words: [], related: related(new Set()) }
  const inWords = new Set<string>()
  for (const w of words) for (const id of w.ids) inWords.add(id)
  return { words: scoreWords(words), related: related(inWords) }
}

function scoreWords<T>(words: WordEntry<T>[]): Bands<T>['words'] {
  return words.map((w, i) => ({ item: w.item, score: matchScore('words', w.score ?? wordScore(i, words.length)) }))
}

/**
 * One best-first list from several best-first lists (slides, images, the well). Items are ordered by
 * how far down their own list they sit (i / n), ties by list order, so no store's hits are buried
 * under another's.
 */
export function interleave<T>(lists: T[][]): T[] {
  const keyed: Array<{ item: T; frac: number; list: number; i: number }> = []
  lists.forEach((l, list) => l.forEach((item, i) => keyed.push({ item, frac: i / l.length, list, i })))
  keyed.sort((a, b) => a.frac - b.frac || a.list - b.list || a.i - b.i)
  return keyed.map((k) => k.item)
}
