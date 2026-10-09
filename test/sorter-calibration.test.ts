import { describe, it, expect } from 'vitest'
import { applyCalibration, auc, brier, chooseCalibration, fitIsotonic, fitPlatt, reliabilityTable, type Scored } from '../src/main/sorter/calibration'

// Deterministic pseudo-random numbers in [0, 1).
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z))
/** Scores whose true p(keep) is sigmoid(z / 4): the raw sigmoid(z) is badly overconfident. */
function overconfident(n: number, seed: number): Scored[] {
  const r = rng(seed)
  return Array.from({ length: n }, () => {
    const z = (r() - 0.5) * 24
    return { z, keep: r() < sigmoid(z / 4) }
  })
}

describe('calibration methods', () => {
  const xs = overconfident(2000, 1)

  it('Platt recovers the true slope of an overconfident score', () => {
    const c = fitPlatt(xs)
    expect(c.method).toBe('platt')
    if (c.method === 'platt') expect(c.a).toBeCloseTo(0.25, 1)
    expect(applyCalibration(c, 4)).toBeCloseTo(sigmoid(1), 1)
  })

  it('isotonic is monotone and never claims 0 or 1', () => {
    const c = fitIsotonic(xs)
    let last = -1
    for (let z = -15; z <= 15; z += 0.5) {
      const p = applyCalibration(c, z)
      expect(p).toBeGreaterThanOrEqual(last)
      expect(p).toBeGreaterThan(0)
      expect(p).toBeLessThan(1)
      last = p
    }
  })

  it('chooseCalibration beats the raw score on Brier and reports both methods', () => {
    const { calibration, check } = chooseCalibration(xs)
    expect(check.brier.platt).toBeLessThan(check.brier.raw)
    expect(check.brier.isotonic).toBeLessThan(check.brier.raw)
    expect(calibration.method).toBe(check.chosen)
    expect(check.chosen).toBe(check.brier.isotonic < check.brier.platt ? 'isotonic' : 'platt')
    expect(check.reliability.platt.reduce((s, r) => s + r.n, 0)).toBe(xs.length)
  })

  it('calibrated probabilities match observed rates on fresh data', () => {
    const { calibration } = chooseCalibration(xs)
    const fresh = overconfident(4000, 7)
    const rows = reliabilityTable(fresh.map((x) => ({ pThrow: 1 - applyCalibration(calibration, x.z), binned: !x.keep })))
    for (const r of rows) if (r.n >= 100) expect(Math.abs(r.meanPredicted! - r.observed!)).toBeLessThan(0.06)
  })
})

describe('report measures', () => {
  it('reliability table bands p(throwaway); the top band includes 1', () => {
    const rows = reliabilityTable([
      { pThrow: 0.05, binned: false },
      { pThrow: 0.95, binned: true },
      { pThrow: 1, binned: false },
      { pThrow: 0.5, binned: true }
    ])
    expect(rows.map((r) => r.n)).toEqual([1, 0, 0, 1, 0, 2])
    expect(rows[5]).toMatchObject({ from: 0.9, to: 1, observed: 0.5 })
    expect(rows[1].observed).toBeNull()
  })

  it('AUC and Brier', () => {
    expect(auc([{ p: 0.9, keep: true }, { p: 0.1, keep: false }])).toBe(1)
    expect(auc([{ p: 0.5, keep: true }, { p: 0.5, keep: false }])).toBe(0.5)
    expect(auc([{ p: 0.5, keep: true }])).toBeNull()
    expect(brier([{ p: 1, keep: true }, { p: 0.5, keep: false }])).toBeCloseTo(0.125)
  })
})
