/**
 * Related screenshots (near-duplicates, bursts of the same window) must fall on the same side of
 * every split, or the held-back report and cross-validation would test on near-copies of training
 * pictures. Two screenshots are related when their embeddings have cosine ≥ `cosine` (default 0.95:
 * on his history the median pair is ~0.65 and the 99.9th percentile ~0.90, so 0.95 links only near-
 * copies), or when they share a non-empty app AND window title and were taken within `minutes` of
 * each other. Groups are the connected components of that relation (union-find). Pure.
 */

export type GroupInput = {
  id: string
  vector: Float32Array
  app?: string
  windowTitle?: string
  /** Local time 'YYYY-MM-DDTHH:MM:SS' (from the file name), or '' / undefined when unknown. */
  takenAt?: string
}

export type GroupOptions = { cosine?: number; minutes?: number }

export type Grouping = {
  /** item id → group id (the smallest member id, so it is stable). */
  groupOf: Map<string, string>
  groups: number
  largest: number
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

export function groupRelated(items: GroupInput[], opts: GroupOptions = {}): Grouping {
  const cosine = opts.cosine ?? 0.95
  const windowMs = (opts.minutes ?? 5) * 60_000
  const parent = items.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }
  const times = items.map((it) => {
    const t = it.takenAt ? Date.parse(it.takenAt) : NaN
    return Number.isFinite(t) ? t : null
  })
  const sameWindowKey = items.map((it) => (it.app?.trim() && it.windowTitle?.trim() ? `${it.app.trim()}\0${it.windowTitle.trim()}` : null))
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (find(i) === find(j)) continue
      const sameWindow = sameWindowKey[i] !== null && sameWindowKey[i] === sameWindowKey[j] && times[i] !== null && times[j] !== null && Math.abs(times[i]! - times[j]!) <= windowMs
      if (sameWindow || dot(items[i].vector, items[j].vector) >= cosine) union(i, j)
    }
  }
  const members = new Map<number, string[]>()
  items.forEach((it, i) => {
    const r = find(i)
    members.set(r, [...(members.get(r) ?? []), it.id])
  })
  const groupOf = new Map<string, string>()
  let largest = 0
  for (const ids of members.values()) {
    const gid = [...ids].sort()[0]
    for (const id of ids) groupOf.set(id, gid)
    largest = Math.max(largest, ids.length)
  }
  return { groupOf, groups: members.size, largest }
}

/**
 * Stratified group k-fold: whole groups go to one fold. Groups are placed largest first (ties by
 * key, so the result is deterministic), each into the fold holding the fewest items of the group's
 * majority label, then the fewest items overall. Items without a group are groups of one, and for
 * those this reduces to dealing each label round-robin in input order.
 */
export function groupKFold<T extends { keep: boolean; group?: string }>(xs: T[], k: number): T[][] {
  const byGroup = new Map<string, T[]>()
  xs.forEach((x, i) => {
    const key = x.group ?? `#${String(i).padStart(9, '0')}`
    byGroup.set(key, [...(byGroup.get(key) ?? []), x])
  })
  const groups = [...byGroup].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))
  const folds: T[][] = Array.from({ length: k }, () => [])
  const keepIn = new Array(k).fill(0)
  const binIn = new Array(k).fill(0)
  for (const [, members] of groups) {
    const keeps = members.filter((m) => m.keep).length
    const majorityKeep = keeps * 2 >= members.length
    let best = 0
    for (let f = 1; f < k; f++) {
      const a = majorityKeep ? keepIn[f] : binIn[f]
      const b = majorityKeep ? keepIn[best] : binIn[best]
      if (a < b || (a === b && folds[f].length < folds[best].length)) best = f
    }
    folds[best].push(...members)
    keepIn[best] += keeps
    binIn[best] += members.length - keeps
  }
  return folds
}
