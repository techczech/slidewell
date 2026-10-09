/**
 * Calibration: turn the classifier's raw score into a probability that means what it says ("of the
 * screenshots given p(keep) = 0.2, about 20% were kept"). Two methods, both fitted on out-of-fold
 * scores (never on the examples a score was trained on):
 *   - Platt scaling: p = sigmoid(a·z + b) on the raw log-odds z, with Platt's smoothed targets.
 *   - Isotonic regression: pool-adjacent-violators on z, block rates lightly smoothed
 *     ((kept + 0.5) / (n + 1)) so a small pure block never claims 0 or 1, then linear interpolation.
 * chooseCalibration compares them by cross-validated Brier score on the same out-of-fold scores and
 * keeps the better one. Also here: Brier score, reliability table and AUC. Pure.
 */

/** One out-of-fold score: raw log-odds of keep, and whether he kept it. */
import { groupKFold } from './groups'

export type Scored = { z: number; keep: boolean; group?: string }

export type Calibration = { method: 'platt'; a: number; b: number } | { method: 'isotonic'; zs: number[]; ps: number[] }

export type ReliabilityRow = { from: number; to: number; n: number; meanPredicted: number | null; observed: number | null }

export type CalibrationCheck = {
  chosen: 'platt' | 'isotonic'
  /** Cross-validated Brier score of p(keep) (lower is better); raw = the uncalibrated sigmoid. */
  brier: { raw: number; platt: number; isotonic: number }
  /** Reliability of p(throwaway) under each method, from the same cross-validation. */
  reliability: { platt: ReliabilityRow[]; isotonic: ReliabilityRow[] }
}

const sigmoid = (z: number): number => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)))

/** Platt scaling by Newton's method with backtracking on (a, b), targets smoothed as in Platt (1999). */
export function fitPlatt(xs: Scored[]): Calibration {
  const nPos = xs.filter((x) => x.keep).length
  const nNeg = xs.length - nPos
  const tPos = (nPos + 1) / (nPos + 2)
  const tNeg = 1 / (nNeg + 2)
  const loss = (a: number, b: number): number => {
    let l = 0
    for (const x of xs) {
      const p = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(a * x.z + b)))
      const t = x.keep ? tPos : tNeg
      l -= t * Math.log(p) + (1 - t) * Math.log(1 - p)
    }
    return l
  }
  let a = 1
  let b = 0
  let cur = loss(a, b)
  for (let it = 0; it < 100; it++) {
    let g1 = 0
    let g2 = 0
    let h11 = 1e-9
    let h12 = 0
    let h22 = 1e-9
    for (const x of xs) {
      const p = sigmoid(a * x.z + b)
      const d = p - (x.keep ? tPos : tNeg)
      const w = p * (1 - p)
      g1 += d * x.z
      g2 += d
      h11 += w * x.z * x.z
      h12 += w * x.z
      h22 += w
    }
    const det = h11 * h22 - h12 * h12
    if (Math.abs(det) < 1e-12) break
    const da = (h22 * g1 - h12 * g2) / det
    const db = (h11 * g2 - h12 * g1) / det
    let step = 1
    let next = loss(a - da, b - db)
    while (next > cur && step > 1e-6) {
      step /= 2
      next = loss(a - step * da, b - step * db)
    }
    if (next > cur) break
    a -= step * da
    b -= step * db
    const done = cur - next < 1e-10
    cur = next
    if (done) break
  }
  return { method: 'platt', a, b }
}

/**
 * Isotonic regression (pool adjacent violators) of keep on z. Identical scores are first pooled into
 * one weighted block, so the fit (and the prediction at a knot) does not depend on input order.
 */
export function fitIsotonic(xs: Scored[]): Calibration {
  type Block = { sumZ: number; kept: number; n: number }
  const ties = new Map<number, Block>()
  for (const x of xs) {
    const b = ties.get(x.z) ?? { sumZ: 0, kept: 0, n: 0 }
    b.sumZ += x.z
    b.kept += x.keep ? 1 : 0
    b.n += 1
    ties.set(x.z, b)
  }
  const blocks: Block[] = []
  for (const [, t] of [...ties].sort((p, q) => p[0] - q[0])) {
    blocks.push({ ...t })
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1]
      const a = blocks[blocks.length - 2]
      if (a.kept / a.n < b.kept / b.n) break
      blocks.splice(blocks.length - 2, 2, { sumZ: a.sumZ + b.sumZ, kept: a.kept + b.kept, n: a.n + b.n })
    }
  }
  const zs: number[] = []
  const ps: number[] = []
  let floor = 0
  for (const b of blocks) {
    const p = Math.max(floor, (b.kept + 0.5) / (b.n + 1)) // smoothing, then keep it monotone
    floor = p
    zs.push(b.sumZ / b.n)
    ps.push(p)
  }
  return { method: 'isotonic', zs, ps }
}

/** Calibrated p(keep) for a raw log-odds score. */
export function applyCalibration(c: Calibration | null | undefined, z: number): number {
  if (!c) return sigmoid(z)
  if (c.method === 'platt') return sigmoid(c.a * z + c.b)
  const { zs, ps } = c
  if (zs.length === 0) return sigmoid(z)
  if (z <= zs[0]) return ps[0]
  if (z >= zs[zs.length - 1]) return ps[ps.length - 1]
  let i = 1
  while (zs[i] < z) i++
  const t = (z - zs[i - 1]) / (zs[i] - zs[i - 1] || 1)
  return ps[i - 1] + t * (ps[i] - ps[i - 1])
}

/** Mean squared error of p(keep) against what he did. */
export function brier(xs: Array<{ p: number; keep: boolean }>): number {
  if (!xs.length) return 0
  return xs.reduce((s, x) => s + (x.p - (x.keep ? 1 : 0)) ** 2, 0) / xs.length
}

/** Bands of p(throwaway) used in reports; the last band is the throwaway band at the default threshold. */
export const RELIABILITY_EDGES = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1]

/** Per band of predicted p(throwaway): how many, the mean prediction, and the share he actually binned. */
export function reliabilityTable(xs: Array<{ pThrow: number; binned: boolean }>, edges: number[] = RELIABILITY_EDGES): ReliabilityRow[] {
  const rows: ReliabilityRow[] = []
  for (let i = 0; i < edges.length - 1; i++) {
    const last = i === edges.length - 2
    const inBand = xs.filter((x) => x.pThrow >= edges[i] && (last ? x.pThrow <= edges[i + 1] : x.pThrow < edges[i + 1]))
    rows.push({
      from: edges[i],
      to: edges[i + 1],
      n: inBand.length,
      meanPredicted: inBand.length ? inBand.reduce((s, x) => s + x.pThrow, 0) / inBand.length : null,
      observed: inBand.length ? inBand.filter((x) => x.binned).length / inBand.length : null
    })
  }
  return rows
}

/** Area under the ROC curve of p(keep): the chance a kept screenshot scores above a binned one. */
export function auc(xs: Array<{ p: number; keep: boolean }>): number | null {
  const pos = xs.filter((x) => x.keep).map((x) => x.p)
  const neg = xs.filter((x) => !x.keep).map((x) => x.p)
  if (!pos.length || !neg.length) return null
  let s = 0
  for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0
  return s / (pos.length * neg.length)
}

/** Label-stratified group folds over out-of-fold scores, spread across the score range (deterministic). */
function foldsOf(xs: Scored[], k: number): Scored[][] {
  return groupKFold([...xs].sort((p, q) => p.z - q.z), k)
}

/**
 * Compare Platt and isotonic by k-fold cross-validated Brier score on the out-of-fold scores, then
 * fit the better one on all of them.
 */
export function chooseCalibration(xs: Scored[], k = 5): { calibration: Calibration; check: CalibrationCheck } {
  const parts = foldsOf(xs, Math.max(2, Math.min(k, xs.length)))
  const preds: Record<'raw' | 'platt' | 'isotonic', Array<{ p: number; keep: boolean }>> = { raw: [], platt: [], isotonic: [] }
  parts.forEach((test, f) => {
    const fitOn = parts.flatMap((p, j) => (j === f ? [] : p))
    if (!test.length || !fitOn.some((x) => x.keep) || !fitOn.some((x) => !x.keep)) return
    const platt = fitPlatt(fitOn)
    const iso = fitIsotonic(fitOn)
    for (const x of test) {
      preds.raw.push({ p: sigmoid(x.z), keep: x.keep })
      preds.platt.push({ p: applyCalibration(platt, x.z), keep: x.keep })
      preds.isotonic.push({ p: applyCalibration(iso, x.z), keep: x.keep })
    }
  })
  const b = { raw: brier(preds.raw), platt: brier(preds.platt), isotonic: brier(preds.isotonic) }
  const chosen: 'platt' | 'isotonic' = b.isotonic < b.platt ? 'isotonic' : 'platt'
  const rel = (ps: Array<{ p: number; keep: boolean }>): ReliabilityRow[] => reliabilityTable(ps.map((x) => ({ pThrow: 1 - x.p, binned: !x.keep })))
  return {
    calibration: chosen === 'platt' ? fitPlatt(xs) : fitIsotonic(xs),
    check: { chosen, brier: b, reliability: { platt: rel(preds.platt), isotonic: rel(preds.isotonic) } }
  }
}
