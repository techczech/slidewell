/**
 * Look-alike groups: images that look the same even when they are not byte-identical (the same
 * screenshot with an arrow added, a re-taken shot of one screen, a re-exported slide). Grouping is by
 * appearance, over the picture-search embeddings already stored (768-d, L2-normalised: cosine = dot
 * product), with a 64-bit pixel fingerprint (dHash) as the tie-breaker for "same picture".
 * Spec: presentation-system 2026-10-09 screenshots-and-talkweaver, part G. Pure: no files, no Electron.
 *
 * Two tiers per pair:
 *   same-picture  identical-looking (re-saved, re-exported, re-taken without change)
 *   same-thing    the same thing, changed (annotated, cropped a little, re-taken with small changes)
 *
 * Transitivity rule: COMPLETE-LINK. An item joins a group only if it is related (same-thing or
 * better) to EVERY member, so every pair inside a group is a look-alike pair and "N versions" is
 * true of all N. Single-link would chain A~B, B~C into one group although A and C look different,
 * and one drifting slide series would swallow the result list. Items are taken in the order given
 * (search rank), each joining the first group it fits, so the best-ranked item anchors its group.
 * A group's tier is same-picture only when every pair in it is same-picture.
 *
 * Items with no embedding stay alone here; the caller keeps its text-only grouping for them.
 */

/**
 * PROVISIONAL thresholds. Chosen from the cosine distribution of his screenshots and the 40-pair
 * contact sheet shown to him for judgement (see the ticket report); fix them after his verdict.
 * One block so a verdict changes one place.
 */
export const LOOK_ALIKE_THRESHOLDS = {
  /** cosine at or above → at least "same thing, changed". */
  sameThing: 0.9,
  /** cosine at or above → "same picture" without needing the fingerprint. */
  samePicture: 0.99,
  /** between this and samePicture the fingerprint decides: close hash → same picture, else same thing. */
  samePictureWithHash: 0.95,
  /** dHash distance (of 64 bits) at or below which two pictures count as pixel-identical-looking. */
  hashSame: 6,
  /** a known dHash distance above this stops a high cosine from being "same picture". */
  hashDifferent: 22
}
export type LookAlikeThresholds = typeof LOOK_ALIKE_THRESHOLDS

export type Tier = 'same-picture' | 'same-thing'

export type LookAlikeItem = {
  id: string
  /** null/undefined: not embedded (never grouped by appearance). */
  vector?: Float32Array | null
  /** 64-bit difference hash, when known (fingerprint.ts); optional, only breaks ties. */
  dhash?: bigint | null
}

export type LookAlikeGroup = {
  /** Member ids in input order. */
  ids: string[]
  /** null for a group of one. */
  tier: Tier | null
}

export type LookAlikeResult = {
  groups: LookAlikeGroup[]
  /** Ids in a pair whose tier hinges on the fingerprint and that had none: compute these and group again. */
  ambiguousIds: string[]
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** 64-bit dHash from a 9×8 greyscale picture (9 columns, 8 rows, row-major): bit = left pixel brighter than right. */
export function dHashFromGrey(grey: ArrayLike<number>): bigint {
  if (grey.length !== 72) throw new Error('dHash needs a 9x8 greyscale picture (72 values)')
  let h = 0n
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      h = (h << 1n) | (grey[y * 9 + x] > grey[y * 9 + x + 1] ? 1n : 0n)
    }
  }
  return h
}

export function hashDistance(a: bigint, b: bigint): number {
  let x = a ^ b
  let n = 0
  while (x) {
    n += Number(x & 1n)
    x >>= 1n
  }
  return n
}

export type PairVerdict = { tier: Tier | null; /** the tier depended on a fingerprint that is not known */ needsHash: boolean }

/** The tier of one pair given its cosine and (optionally) its dHash distance. */
export function tierOf(cos: number, hashDist: number | null, t: LookAlikeThresholds = LOOK_ALIKE_THRESHOLDS): PairVerdict {
  if (cos < t.sameThing) return { tier: null, needsHash: false }
  if (cos >= t.samePicture) return { tier: hashDist !== null && hashDist > t.hashDifferent ? 'same-thing' : 'same-picture', needsHash: false }
  if (cos >= t.samePictureWithHash) {
    if (hashDist === null) return { tier: 'same-thing', needsHash: true }
    return { tier: hashDist <= t.hashSame ? 'same-picture' : 'same-thing', needsHash: false }
  }
  return { tier: 'same-thing', needsHash: false }
}

export function pairTier(a: LookAlikeItem, b: LookAlikeItem, t: LookAlikeThresholds = LOOK_ALIKE_THRESHOLDS): PairVerdict {
  if (!a.vector || !b.vector) return { tier: null, needsHash: false }
  const d = a.dhash != null && b.dhash != null ? hashDistance(a.dhash, b.dhash) : null
  return tierOf(cosine(a.vector, b.vector), d, t)
}

type Building = { members: LookAlikeItem[]; allSame: boolean }

/** Group `items` (in rank order) into look-alike groups, complete-link. Every input id is in exactly one group. */
export function groupLookAlikes(items: LookAlikeItem[], t: LookAlikeThresholds = LOOK_ALIKE_THRESHOLDS): LookAlikeResult {
  const building: Building[] = []
  const ambiguous = new Set<string>()
  for (const item of items) {
    let home: Building | null = null
    let homeAllSame = true
    if (item.vector) {
      for (const g of building) {
        if (!g.members[0].vector) continue
        // anchor first: most groups fail on it, so most items cost one dot product per group
        const first = pairTier(g.members[0], item, t)
        if (first.tier === null) continue
        let ok = true
        let allSame = g.allSame && first.tier === 'same-picture'
        const seen: string[] = first.needsHash ? [g.members[0].id] : []
        for (let i = 1; i < g.members.length && ok; i++) {
          const v = pairTier(g.members[i], item, t)
          if (v.tier === null) ok = false
          else {
            if (v.tier !== 'same-picture') allSame = false
            if (v.needsHash) seen.push(g.members[i].id)
          }
        }
        if (!ok) continue
        if (seen.length) {
          ambiguous.add(item.id)
          for (const s of seen) ambiguous.add(s)
        }
        home = g
        homeAllSame = allSame
        break
      }
    }
    if (home) {
      home.members.push(item)
      home.allSame = homeAllSame
    } else building.push({ members: [item], allSame: true })
  }
  return {
    groups: building.map((g) => ({ ids: g.members.map((m) => m.id), tier: g.members.length > 1 ? (g.allSame ? 'same-picture' : 'same-thing') : null })),
    ambiguousIds: [...ambiguous]
  }
}

/**
 * Pass 1 without fingerprints, pass 2 with those that `fingerprint` supplies for the ambiguous pairs.
 * `fingerprint` is only called for ids that sit in a pair whose tier needs it.
 */
export async function groupWithFingerprints(
  items: LookAlikeItem[],
  fingerprint: (ids: string[]) => Promise<Map<string, bigint>>,
  t: LookAlikeThresholds = LOOK_ALIKE_THRESHOLDS
): Promise<LookAlikeGroup[]> {
  const first = groupLookAlikes(items, t)
  if (first.ambiguousIds.length === 0) return first.groups
  const hashes = await fingerprint(first.ambiguousIds)
  if (hashes.size === 0) return first.groups
  return groupLookAlikes(items.map((i) => (hashes.has(i.id) ? { ...i, dhash: hashes.get(i.id)! } : i)), t).groups
}

/**
 * The sorter's duplicate signal: the best tier between one picture and any already-kept picture, or
 * null. Without fingerprints a pair in the hash-decided band counts as same-thing.
 */
export function bestKeptTier(vector: Float32Array, kept: Iterable<Float32Array>, t: LookAlikeThresholds = LOOK_ALIKE_THRESHOLDS): Tier | null {
  let best: Tier | null = null
  for (const k of kept) {
    const c = cosine(vector, k)
    if (c < t.sameThing) continue
    if (c >= t.samePicture) return 'same-picture'
    best = 'same-thing'
  }
  return best
}
