/**
 * Worker thread for the CPU-bound training steps (jobs.ts: grouping related screenshots, fitting the
 * classifier), so the main process stays responsive and Stop can terminate the work. Input:
 * workerData = a Job; output: one message, { result } or { error }. Built by electron-vite through the
 * `?nodeWorker` import in index.ts.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { runJob, type Job } from './jobs'

try {
  parentPort?.postMessage({ result: runJob(workerData as Job) })
} catch (e) {
  parentPort?.postMessage({ error: (e as Error)?.message ?? String(e) })
}
