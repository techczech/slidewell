/**
 * The accuracy report: how the sorter does on a held-back sample of his own past choices. Pure
 * functions: a deterministic, label-stratified hold-out split, and the report over labelled
 * predictions (keep precision, throwaway precision, share doubtful, and the costly error: kept
 * screenshots the sorter would have thrown away).
 */
import type { Proposal } from './decide'

export type Truth = 'keep' | 'throwaway'
export type LabelledPrediction = { truth: Truth; proposal: Proposal }

export type PrecisionLine = { proposed: number; correct: number; precision: number | null }

export type AccuracyReport = {
  sample: number
  truth: { keep: number; throwaway: number }
  keep: PrecisionLine
  throwaway: PrecisionLine
  doubtful: { count: number; share: number }
  /** Screenshots he kept that the sorter proposed to throw away (the error the keep-bias guards). */
  keptProposedThrowaway: number
  /** Screenshots he binned that the sorter proposed to keep. */
  binnedProposedKeep: number
}

const line = (rows: LabelledPrediction[], p: 'keep' | 'throwaway'): PrecisionLine => {
  const proposed = rows.filter((r) => r.proposal === p)
  const correct = proposed.filter((r) => r.truth === p).length
  return { proposed: proposed.length, correct, precision: proposed.length ? correct / proposed.length : null }
}

export function accuracyReport(rows: LabelledPrediction[]): AccuracyReport {
  const doubtful = rows.filter((r) => r.proposal === 'doubtful').length
  return {
    sample: rows.length,
    truth: { keep: rows.filter((r) => r.truth === 'keep').length, throwaway: rows.filter((r) => r.truth === 'throwaway').length },
    keep: line(rows, 'keep'),
    throwaway: line(rows, 'throwaway'),
    doubtful: { count: doubtful, share: rows.length ? doubtful / rows.length : 0 },
    keptProposedThrowaway: rows.filter((r) => r.truth === 'keep' && r.proposal === 'throwaway').length,
    binnedProposedKeep: rows.filter((r) => r.truth === 'throwaway' && r.proposal === 'keep').length
  }
}

/** FNV-1a 32-bit: a stable order key that does not depend on insertion order. */
function fnv(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/**
 * Hold back about `fraction` of each label, whole groups at a time (groups.ts: related screenshots
 * never straddle the split). Groups are visited in hash order of their id, so the same history always
 * gives the same split; a group joins the held-back side only while that keeps every label at or below
 * its target (ceil(fraction × count), none for a label with fewer than two). Without `groupOf` every
 * item is its own group.
 */
export function holdOutSplit<T>(items: T[], idOf: (t: T) => string, labelOf: (t: T) => string, fraction = 0.2, groupOf?: (t: T) => string): { train: T[]; test: T[] } {
  const gid = groupOf ?? idOf
  const groups = new Map<string, T[]>()
  const totals = new Map<string, number>()
  for (const it of items) {
    groups.set(gid(it), [...(groups.get(gid(it)) ?? []), it])
    totals.set(labelOf(it), (totals.get(labelOf(it)) ?? 0) + 1)
  }
  const target = new Map([...totals].map(([l, n]) => [l, n >= 2 ? Math.max(1, Math.ceil(n * fraction)) : 0]))
  const taken = new Map<string, number>()
  const ordered = [...groups.keys()].sort((a, b) => fnv(a) - fnv(b) || (a < b ? -1 : 1))
  const train: T[] = []
  const test: T[] = []
  for (const g of ordered) {
    const members = groups.get(g)!
    const add = new Map<string, number>()
    for (const m of members) add.set(labelOf(m), (add.get(labelOf(m)) ?? 0) + 1)
    const fits = [...add].every(([l, n]) => (taken.get(l) ?? 0) + n <= (target.get(l) ?? 0))
    if (fits) {
      for (const [l, n] of add) taken.set(l, (taken.get(l) ?? 0) + n)
      test.push(...members)
    } else train.push(...members)
  }
  return { train, test }
}

/** Least held-back evidence before the sorter may run unattended. */
export const MIN_HELD_BACK = { total: 20, perLabel: 5 }

/** True when the held-back sample is big enough to trust its numbers. */
export function enoughToMeasure(a: AccuracyReport | null | undefined): boolean {
  return Boolean(a && a.sample >= MIN_HELD_BACK.total && a.truth.keep >= MIN_HELD_BACK.perLabel && a.truth.throwaway >= MIN_HELD_BACK.perLabel)
}
