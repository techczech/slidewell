/**
 * Owns the one Triage import run in the main process: refuses a second run while one is going (the
 * second caller is handed the first run's result), reports progress as snapshots in order, and
 * always ends in 'done' or 'failed' — never silently.
 */
import { failureMessage, type ImportSnapshot } from './triage-import-progress'

export type ImportOutcome = { imported: number; skipped: number; gated: number }

export function createImportRunner(deps: {
  /** Does the import. `onStep(done, total)` is called once the total is known (done 0) and after each file. */
  work: (onStep: (done: number, total: number) => void, forceHashes: string[]) => Promise<ImportOutcome>
  emit: (snap: ImportSnapshot) => void
}): {
  start: (forceHashes?: string[]) => Promise<ImportOutcome & { error?: string }>
  status: () => ImportSnapshot | null
} {
  let current: ImportSnapshot | null = null
  let inFlight: Promise<ImportOutcome & { error?: string }> | null = null
  const set = (s: ImportSnapshot): void => {
    current = s
    deps.emit(s)
  }
  return {
    status: () => current,
    start(forceHashes = []) {
      if (inFlight) return inFlight // already running: adopt it, never a second run
      set({ phase: 'working', done: 0, total: 0 })
      inFlight = (async () => {
        try {
          const r = await deps.work((done, total) => set({ phase: 'working', done, total }), forceHashes)
          set({ phase: 'done', imported: r.imported, skipped: r.skipped, gated: r.gated })
          return r
        } catch (err) {
          const message = failureMessage(err)
          set({ phase: 'failed', message })
          return { imported: 0, skipped: 0, gated: 0, error: message }
        } finally {
          inFlight = null
        }
      })()
      return inFlight
    }
  }
}
