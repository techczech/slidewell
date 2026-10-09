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
 * Hold back `fraction` of each label (rounded up, at least one when the label has two or more),
 * chosen by a hash of the id, so the same history always gives the same split.
 */
export function holdOutSplit<T>(items: T[], idOf: (t: T) => string, labelOf: (t: T) => string, fraction = 0.2): { train: T[]; test: T[] } {
  const byLabel = new Map<string, T[]>()
  for (const it of items) {
    const k = labelOf(it)
    byLabel.set(k, [...(byLabel.get(k) ?? []), it])
  }
  const train: T[] = []
  const test: T[] = []
  for (const group of byLabel.values()) {
    const ordered = [...group].sort((a, b) => fnv(idOf(a)) - fnv(idOf(b)) || (idOf(a) < idOf(b) ? -1 : 1))
    const n = group.length >= 2 ? Math.max(1, Math.ceil(group.length * fraction)) : 0
    test.push(...ordered.slice(0, n))
    train.push(...ordered.slice(n))
  }
  return { train, test }
}
