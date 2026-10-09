import { describe, it, expect } from 'vitest'
import { train, predictKeep, type Example } from '../src/main/sorter/classifier'
import { normalise } from '../src/main/picture-search/engine'

// Synthetic embeddings: a shared "screenshot" direction (every picture is mostly alike, as with real
// embeddings), plus a small keep or throwaway direction, plus deterministic noise.
const DIM = 32
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32 - 0.5
  }
}
function synth(n: number, keep: boolean, seed: number, signal = 0.25): Example[] {
  const r = rng(seed)
  return Array.from({ length: n }, () => {
    const v = new Float32Array(DIM)
    v[0] = 1
    v[keep ? 1 : 2] = signal
    for (let i = 3; i < DIM; i++) v[i] = r() * 0.2
    return { vector: normalise(v), keep }
  })
}

describe('sorter classifier: train / predict', () => {
  const data = [...synth(60, true, 1), ...synth(20, false, 2)]
  const model = train(data, { epochs: 200 })

  it('learns his keep/bin split from embeddings and generalises to new pictures', () => {
    const fresh = [...synth(30, true, 11), ...synth(30, false, 12)]
    const right = fresh.filter((e) => (predictKeep(model, e.vector) >= 0.5) === e.keep).length
    expect(right / fresh.length).toBeGreaterThan(0.9)
  })

  it('class weighting: a 3:1 history does not bias the raw score of an in-between picture towards keep', () => {
    const raw = train(data, { epochs: 200, calibrate: false })
    const mid = new Float32Array(DIM)
    mid[0] = 1
    mid[1] = 0.125
    mid[2] = 0.125
    expect(Math.abs(predictKeep(raw, normalise(mid)) - 0.5)).toBeLessThan(0.15)
  })

  it('is deterministic and serialisable', () => {
    const again = train(data, { epochs: 200 })
    expect(again.weights).toEqual(model.weights)
    const round = JSON.parse(JSON.stringify(model))
    expect(predictKeep(round, data[0].vector)).toBeCloseTo(predictKeep(model, data[0].vector), 12)
    expect(model.trainedOn).toEqual({ keep: 60, throwaway: 20 })
    expect(model.calibration?.method).toMatch(/platt|isotonic/)
    expect(model.calibrationCheck?.chosen).toBe(model.calibration?.method)
  })

  it('refuses training without both labels, and vectors of the wrong length', () => {
    expect(() => train(synth(5, true, 3))).toThrow(/both/)
    expect(() => train([])).toThrow()
    expect(() => predictKeep(model, new Float32Array(DIM + 1))).toThrow(/expects/)
  })
})
