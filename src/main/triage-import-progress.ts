/**
 * What the Triage "Import → well" control shows while a run is going, and after. Pure: the main
 * process builds snapshots with it (triage-import-run.ts) and the renderer folds them into its
 * state, so both sides agree on the wording. A snapshot is the whole truth about the run at that
 * moment, so a late listener (the panel reopened mid-run) can adopt a run it did not start.
 */
export type ImportSnapshot =
  | { phase: 'working'; done: number; total: number } // total 0 = the list of staged files is still being read
  | { phase: 'done'; imported: number; skipped: number; gated: number }
  | { phase: 'failed'; message: string }

export type ImportState = { phase: 'idle' } | ImportSnapshot

export const IDLE: ImportState = { phase: 'idle' }

export const isWorking = (s: ImportState): boolean => s.phase === 'working'

/** A click starts a run only when none is going; the state flips to working at once (before main answers). */
export function startClick(s: ImportState): { state: ImportState; start: boolean } {
  if (isWorking(s)) return { state: s, start: false }
  return { state: { phase: 'working', done: 0, total: 0 }, start: true }
}

/** Fold a snapshot from main into the state. Counts never go backwards within a run. */
export function applySnapshot(s: ImportState, snap: ImportSnapshot): ImportState {
  if (snap.phase === 'working' && s.phase === 'working') {
    return { phase: 'working', total: Math.max(s.total, snap.total), done: Math.max(s.done, Math.min(snap.done, Math.max(s.total, snap.total))) }
  }
  return snap
}

/** What main reports on opening the panel: only a run still going is adopted; old results are not replayed. */
export function adoptStatus(status: ImportSnapshot | null | undefined): ImportState {
  return status && status.phase === 'working' ? status : IDLE
}

export const importButtonLabel = (s: ImportState, selected: number): string => (isWorking(s) ? 'Importing…' : `⤓ Import ${selected} → well`)

const n = (x: number): string => x.toLocaleString('en-GB')

/** The line next to the button while working, or the result / failure after; '' when idle. */
export function importLine(s: ImportState): string {
  if (s.phase === 'working') return s.total > 0 ? `Importing ${n(s.done)} of ${n(s.total)}…` : 'Getting ready to import…'
  if (s.phase === 'done') {
    if (s.imported === 0 && s.skipped === 0 && s.gated === 0) return 'Nothing to import.'
    const parts = [`Imported ${n(s.imported)}.`]
    if (s.skipped > 0) parts.push(`${n(s.skipped)} could not be imported (missing, online-only or unreadable) and ${s.skipped === 1 ? 'stays' : 'stay'} selected.`)
    if (s.gated > 0) parts.push(`${n(s.gated)} ${s.gated === 1 ? 'video is' : 'videos are'} over the 20 MB limit and ${s.gated === 1 ? 'stays' : 'stay'} selected.`)
    return parts.join(' ')
  }
  if (s.phase === 'failed') return s.message
  return ''
}

/** The one plain sentence for a failure; never empty. */
export function failureMessage(err: unknown): string {
  const why = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return `The import stopped before it finished${why ? ` (${why.replace(/\.+$/, '')})` : ''}. Anything already imported is kept; the rest stays selected.`
}
