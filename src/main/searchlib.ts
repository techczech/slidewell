/**
 * Pure search logic: query-token parsing, date/owner/category filtering, and
 * near-identical clustering. Ported from raycast-slide-search
 * (tokens.ts + filter.ts + cluster.ts). No I/O.
 */
import { type DeckMetaIndex, type Ownership, deckMatchesSubstring, categoryMatches } from './deckmeta'

// ---------- tokens ----------
export interface DateFilter {
  fromInclusive: string | null
  toExclusive: string | null
}
export type OwnerToken = 'mine' | 'others' | 'unknown' | 'all' | null
export interface ParsedQuery {
  text: string
  date: DateFilter | null
  deckSubstrings: string[]
  categorySubstrings: string[]
  owner: OwnerToken
  recognised: string[]
}

function nextDay(iso: string): string {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10))
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + 1)
  return dt.toISOString().slice(0, 10)
}
function rangeForValue(value: string): { start: string; end: string } | null {
  const v = value.trim()
  if (/^\d{4}$/.test(v)) {
    const y = parseInt(v, 10)
    return { start: `${y}-01-01`, end: `${y + 1}-01-01` }
  }
  if (/^\d{4}-\d{2}$/.test(v)) {
    const [y, m] = v.split('-').map((n) => parseInt(n, 10))
    const endMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
    return { start: `${v}-01`, end: `${endMonth}-01` }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { start: v, end: nextDay(v) }
  return null
}
function mergeDate(acc: DateFilter | null, next: DateFilter): DateFilter {
  if (!acc) return next
  const from =
    acc.fromInclusive && next.fromInclusive
      ? acc.fromInclusive > next.fromInclusive
        ? acc.fromInclusive
        : next.fromInclusive
      : acc.fromInclusive ?? next.fromInclusive
  const to =
    acc.toExclusive && next.toExclusive
      ? acc.toExclusive < next.toExclusive
        ? acc.toExclusive
        : next.toExclusive
      : acc.toExclusive ?? next.toExclusive
  return { fromInclusive: from, toExclusive: to }
}
const TOKEN_RE = /\b(year|after|before|deck|cat|owner):(?:"([^"]*)"|(\S+))/gi
const OWNER_VALUES = new Set(['mine', 'others', 'unknown', 'all'])

export function parseQuery(raw: string): ParsedQuery {
  let date: DateFilter | null = null
  const deckSubstrings: string[] = []
  const categorySubstrings: string[] = []
  let owner: OwnerToken = null
  const recognised: string[] = []
  const text = raw
    .replace(TOKEN_RE, (match, keyRaw: string, quoted?: string, bare?: string) => {
      const key = keyRaw.toLowerCase()
      const value = (quoted ?? bare ?? '').trim()
      if (!value) return ''
      if (key === 'deck') {
        deckSubstrings.push(value.toLowerCase())
        recognised.push(`deck:${value}`)
        return ''
      }
      if (key === 'cat') {
        categorySubstrings.push(value.toLowerCase())
        recognised.push(`cat:${value}`)
        return ''
      }
      if (key === 'owner') {
        const v = value.toLowerCase()
        if (!OWNER_VALUES.has(v)) return match
        owner = v as OwnerToken
        recognised.push(`owner:${v}`)
        return ''
      }
      const range = rangeForValue(value)
      if (!range) return match
      if (key === 'year') date = mergeDate(date, { fromInclusive: range.start, toExclusive: range.end })
      else if (key === 'after') date = mergeDate(date, { fromInclusive: range.end, toExclusive: null })
      else if (key === 'before') date = mergeDate(date, { fromInclusive: null, toExclusive: range.start })
      recognised.push(`${key}:${value}`)
      return ''
    })
    .replace(/\s+/g, ' ')
    .trim()
  return { text, date, deckSubstrings, categorySubstrings, owner, recognised }
}

export function dateMatches(filter: DateFilter, isoDate: string | null): boolean {
  if (!isoDate) return false
  const day = isoDate.slice(0, 10)
  if (filter.fromInclusive && day < filter.fromInclusive) return false
  if (filter.toExclusive && day >= filter.toExclusive) return false
  return true
}

// ---------- filters ----------
export type OwnershipFilter = Ownership | 'all'
export type Era = 'all' | 'recent' | 'mid' | 'early' | string

export function resolveOwnershipFilter(ownerToken: OwnerToken, uiDefault: OwnershipFilter = 'mine'): OwnershipFilter {
  return ownerToken ? ownerToken : uiDefault
}
export function eraToDateFilter(era: Era): DateFilter | null {
  switch (era) {
    case 'all':
      return null
    case 'recent':
      return { fromInclusive: '2023-01-01', toExclusive: null }
    case 'mid':
      return { fromInclusive: '2017-01-01', toExclusive: '2023-01-01' }
    case 'early':
      return { fromInclusive: null, toExclusive: '2017-01-01' }
    default:
      if (/^\d{4}$/.test(era)) {
        const y = parseInt(era, 10)
        return { fromInclusive: `${y}-01-01`, toExclusive: `${y + 1}-01-01` }
      }
      return null
  }
}
function intersectDate(a: DateFilter | null, b: DateFilter | null): DateFilter | null {
  if (!a) return b
  if (!b) return a
  const from =
    a.fromInclusive && b.fromInclusive ? (a.fromInclusive > b.fromInclusive ? a.fromInclusive : b.fromInclusive) : a.fromInclusive ?? b.fromInclusive
  const to =
    a.toExclusive && b.toExclusive ? (a.toExclusive < b.toExclusive ? a.toExclusive : b.toExclusive) : a.toExclusive ?? b.toExclusive
  return { fromInclusive: from, toExclusive: to }
}
export function combinedDateFilter(parsed: ParsedQuery, era: Era): DateFilter | null {
  return intersectDate(parsed.date, eraToDateFilter(era))
}

/** Keep hits whose deck matches date AND every deck/category substring AND ownership. */
export function applyFilters<T extends { deck: string }>(
  hits: T[],
  index: DeckMetaIndex,
  date: DateFilter | null,
  deckSubstrings: string[],
  ownership: OwnershipFilter,
  categorySubstrings: string[]
): T[] {
  const ownerActive = ownership !== 'all'
  if (!date && deckSubstrings.length === 0 && categorySubstrings.length === 0 && !ownerActive) return hits
  return hits.filter((h) => {
    const pid = h.deck
    if (!pid) return false
    const meta = index[pid]
    if (date && !dateMatches(date, meta?.date ?? null)) return false
    if (ownerActive && (meta?.ownership ?? 'unknown') !== ownership) return false
    for (const sub of deckSubstrings) if (!deckMatchesSubstring(meta, pid, sub)) return false
    for (const sub of categorySubstrings) if (!categoryMatches(meta?.category, sub)) return false
    return true
  })
}

// ---------- clustering ----------
export interface SlideCluster<T> {
  representative: T
  members: T[]
  size: number
  deckCount: number
}

export function normaliseSlideText(text: string): string {
  return (text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
function tokenSet(normalised: string): Set<string> {
  if (!normalised) return new Set()
  return new Set(normalised.split(' ').filter(Boolean))
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

const NEAR_TEXT_THRESHOLD = 0.9

/** Greedy single-link clustering of near-identical hits (exact norm text, then Jaccard ≥ 0.9). */
export function clusterHits<T extends { text: string; title: string; rank: number; deck: string }>(
  hits: T[],
  threshold = NEAR_TEXT_THRESHOLD
): SlideCluster<T>[] {
  interface Indexed {
    hit: T
    norm: string
    tokens: Set<string>
    order: number
  }
  const indexed: Indexed[] = hits.map((hit, order) => {
    const norm = normaliseSlideText(hit.text || hit.title || '')
    return { hit, norm, tokens: tokenSet(norm), order }
  })
  const clusters: Indexed[][] = []
  const exactIndex = new Map<string, number>()
  for (const item of indexed) {
    const exact = exactIndex.get(item.norm)
    if (exact !== undefined) {
      clusters[exact].push(item)
      continue
    }
    let joined = -1
    if (item.tokens.size > 0) {
      for (let i = 0; i < clusters.length; i++) {
        const anchor = clusters[i][0]
        if (anchor.tokens.size === 0) continue
        if (jaccard(item.tokens, anchor.tokens) >= threshold) {
          joined = i
          break
        }
      }
    }
    if (joined >= 0) clusters[joined].push(item)
    else {
      const idx = clusters.length
      clusters.push([item])
      if (!exactIndex.has(item.norm)) exactIndex.set(item.norm, idx)
    }
  }
  return clusters.map((group) => {
    const rep = [...group].sort((a, b) => {
      const lenDiff = b.norm.length - a.norm.length
      if (lenDiff !== 0) return lenDiff
      const rankDiff = a.hit.rank - b.hit.rank
      if (rankDiff !== 0) return rankDiff
      return a.order - b.order
    })[0]
    const members = [rep.hit, ...group.filter((g) => g !== rep).sort((a, b) => a.order - b.order).map((g) => g.hit)]
    const ids = new Set<string>()
    for (const m of members) if (m.deck) ids.add(m.deck)
    return { representative: rep.hit, members, size: members.length, deckCount: ids.size }
  })
}
