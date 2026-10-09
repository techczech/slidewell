/**
 * Sorter step 2: a small classifier over picture-search image embeddings (768-d, L2-normalised),
 * trained on his own keep / bin history. L2-regularised logistic regression on centred vectors,
 * class-weighted so the rarer label counts as much as the common one (the prior is 50/50, not his
 * history's mix). The regularisation strength is picked by k-fold cross-validation on the training
 * examples only. The raw score is then calibrated (calibration.ts: Platt or isotonic, whichever has
 * the lower cross-validated Brier score) on out-of-fold scores from the same folds, so p(keep) means
 * what it says. Everything happens inside the examples passed to train(): a held-back sample stays
 * out of fitting and calibration alike. Deterministic: same examples in, same model out.
 *
 * Pure: no Electron, no files. The model is plain JSON (stored by store.ts).
 */

import { applyCalibration, chooseCalibration, type Calibration, type CalibrationCheck, type Scored } from './calibration'

export type Example = { vector: Float32Array; keep: boolean }

export type Classifier = {
  kind: 'logistic-v1'
  dim: number
  /** Training mean, subtracted before the dot product. */
  mean: number[]
  weights: number[]
  bias: number
  l2: number
  trainedOn: { keep: number; throwaway: number }
  /** Maps the raw log-odds to a calibrated p(keep); absent = uncalibrated. */
  calibration?: Calibration
  /** How the calibration was chosen (cross-validated Brier and reliability of both methods). */
  calibrationCheck?: CalibrationCheck
}

/** Candidate L2 strengths for cross-validation. Wide on purpose: a pick at either end means the grid was too narrow. */
export const L2_GRID = [1e-5, 1e-4, 1e-3, 1e-2, 1e-1, 1]

export type TrainOptions = { l2?: number; epochs?: number; folds?: number; l2Grid?: number[]; calibrate?: boolean }

const sigmoid = (z: number): number => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)))

function meanOf(xs: Float32Array[], dim: number): Float64Array {
  const m = new Float64Array(dim)
  for (const x of xs) for (let i = 0; i < dim; i++) m[i] += x[i]
  for (let i = 0; i < dim; i++) m[i] /= Math.max(1, xs.length)
  return m
}

/** Full-batch gradient descent with Adam steps; fixed epochs so it is deterministic and bounded. */
function fit(examples: Example[], dim: number, l2: number, epochs: number): Classifier {
  if (examples.length === 0) throw new Error('no training examples')
  const nKeep = examples.filter((e) => e.keep).length
  const nThrow = examples.length - nKeep
  const mean = meanOf(
    examples.map((e) => e.vector),
    dim
  )
  const xs = examples.map((e) => {
    const c = new Float64Array(dim)
    for (let i = 0; i < dim; i++) c[i] = e.vector[i] - mean[i]
    return c
  })
  const ys = examples.map((e) => (e.keep ? 1 : 0))
  // class weights: each label contributes half the total weight
  const wKeep = nKeep ? examples.length / (2 * nKeep) : 0
  const wThrow = nThrow ? examples.length / (2 * nThrow) : 0
  const sw = ys.map((y) => (y ? wKeep : wThrow))
  const n = examples.length
  const w = new Float64Array(dim)
  let b = 0
  const mW = new Float64Array(dim)
  const vW = new Float64Array(dim)
  let mB = 0
  let vB = 0
  const lr = 0.05
  const b1 = 0.9
  const b2 = 0.999
  const eps = 1e-8
  const g = new Float64Array(dim)
  for (let t = 1; t <= epochs; t++) {
    g.fill(0)
    let gb = 0
    for (let k = 0; k < n; k++) {
      const x = xs[k]
      let z = b
      for (let i = 0; i < dim; i++) z += w[i] * x[i]
      const err = (sigmoid(z) - ys[k]) * sw[k]
      gb += err
      for (let i = 0; i < dim; i++) g[i] += err * x[i]
    }
    for (let i = 0; i < dim; i++) {
      const gi = g[i] / n + l2 * w[i]
      mW[i] = b1 * mW[i] + (1 - b1) * gi
      vW[i] = b2 * vW[i] + (1 - b2) * gi * gi
      w[i] -= (lr * (mW[i] / (1 - b1 ** t))) / (Math.sqrt(vW[i] / (1 - b2 ** t)) + eps)
    }
    gb /= n
    mB = b1 * mB + (1 - b1) * gb
    vB = b2 * vB + (1 - b2) * gb * gb
    b -= (lr * (mB / (1 - b1 ** t))) / (Math.sqrt(vB / (1 - b2 ** t)) + eps)
  }
  return { kind: 'logistic-v1', dim, mean: Array.from(mean), weights: Array.from(w), bias: b, l2, trainedOn: { keep: nKeep, throwaway: nThrow } }
}

/** The raw log-odds that he would keep this picture (before calibration). */
export function rawScore(model: Classifier, v: Float32Array): number {
  if (v.length !== model.dim) throw new Error(`vector has ${v.length} values, model expects ${model.dim}`)
  let z = model.bias
  for (let i = 0; i < model.dim; i++) z += model.weights[i] * (v[i] - model.mean[i])
  return z
}

/** Probability that this picture is one he would keep (0..1), calibrated when the model carries a calibration. */
export function predictKeep(model: Classifier, v: Float32Array): number {
  return applyCalibration(model.calibration, rawScore(model, v))
}

/** Class-weighted log loss of a model on examples (lower is better). */
function weightedLogLoss(model: Classifier, examples: Example[]): number {
  const nKeep = examples.filter((e) => e.keep).length
  const nThrow = examples.length - nKeep
  let s = 0
  for (const e of examples) {
    const p = Math.min(1 - 1e-6, Math.max(1e-6, applyCalibration(null, rawScore(model, e.vector))))
    s += e.keep ? -Math.log(p) / Math.max(1, nKeep) : -Math.log(1 - p) / Math.max(1, nThrow)
  }
  return s / 2
}

/** Interleaved, label-stratified folds (deterministic). */
function folds(examples: Example[], k: number): Example[][] {
  const out: Example[][] = Array.from({ length: k }, () => [])
  let ik = 0
  let it = 0
  for (const e of examples) {
    if (e.keep) out[ik++ % k].push(e)
    else out[it++ % k].push(e)
  }
  return out
}

/**
 * Train on labelled examples. Without `l2`, picks it from `l2Grid` by k-fold cross-validation
 * (class-weighted log loss). Unless `calibrate: false`, calibrates on the out-of-fold scores of the
 * chosen l2. Then fits on every example. Needs at least one of each label.
 */
export function train(examples: Example[], opts: TrainOptions = {}): Classifier {
  if (examples.length === 0) throw new Error('no training examples')
  const dim = examples[0].vector.length
  if (examples.some((e) => e.vector.length !== dim)) throw new Error('training vectors differ in length')
  const nKeep = examples.filter((e) => e.keep).length
  if (nKeep === 0 || nKeep === examples.length) throw new Error('training needs both kept and binned screenshots')
  const epochs = opts.epochs ?? 300
  const k = Math.max(2, Math.min(opts.folds ?? 5, nKeep, examples.length - nKeep))
  const parts = folds(examples, k)
  const foldModels = (l2: number): Array<Classifier | null> =>
    parts.map((test, f) => {
      const trainPart = parts.flatMap((p, j) => (j === f ? [] : p))
      return test.length && trainPart.some((e) => e.keep) && trainPart.some((e) => !e.keep) ? fit(trainPart, dim, l2, epochs) : null
    })
  let l2 = opts.l2
  let bestFolds: Array<Classifier | null> | null = null
  if (l2 === undefined) {
    let best = Infinity
    for (const cand of opts.l2Grid ?? L2_GRID) {
      const ms = foldModels(cand)
      const loss = ms.reduce((s, m, f) => s + (m ? weightedLogLoss(m, parts[f]) : 0), 0)
      if (loss < best) {
        best = loss
        l2 = cand
        bestFolds = ms
      }
    }
  }
  const chosenL2 = l2 ?? 1e-2
  const model = fit(examples, dim, chosenL2, epochs)
  if (opts.calibrate === false) return model
  const ms = bestFolds ?? foldModels(chosenL2)
  const oof: Scored[] = []
  ms.forEach((m, f) => {
    if (m) for (const e of parts[f]) oof.push({ z: rawScore(m, e.vector), keep: e.keep })
  })
  const { calibration, check } = chooseCalibration(oof, k)
  return { ...model, calibration, calibrationCheck: check }
}
