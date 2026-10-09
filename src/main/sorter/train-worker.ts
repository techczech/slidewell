/**
 * Worker thread for classifier training (classifier.ts `train`), so the main process stays
 * responsive during the cross-validated fit. Input: workerData = { examples }; output: one message,
 * { model } or { error }. Built by electron-vite through the `?nodeWorker` import in index.ts.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { train, type Example } from './classifier'

try {
  parentPort?.postMessage({ model: train((workerData as { examples: Example[] }).examples) })
} catch (e) {
  parentPort?.postMessage({ error: (e as Error)?.message ?? String(e) })
}
