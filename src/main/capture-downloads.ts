/**
 * Who may download online-only files for the capture watcher's scans (ticket 15), and when Stop holds.
 * Small interface:
 *   stop()              → kills the active download (aborts the signal) and keeps downloading off
 *   resume()            → an explicit user action (Scan, a new backlog run) turns downloading back on
 *   options(root)       → { downloadRoot, signal } for one scan: no download root while stopped
 *   stopped             → true from Stop until the next resume() or app start
 *
 * Stop stays stopped: the aborted signal is kept, not replaced, so every scan that follows a Stop
 * (the cancelled backlog run's own follow-up scan, watcher events) runs without downloading. Only
 * resume() hands out a fresh signal. A new process starts resumed.
 */
export interface CaptureDownloads {
  readonly stopped: boolean
  stop(): void
  resume(): void
  options(downloadRoot: string | null): { downloadRoot: string | null; signal: AbortSignal }
}

export function createCaptureDownloads(): CaptureDownloads {
  let ctl = new AbortController()
  return {
    get stopped() {
      return ctl.signal.aborted
    },
    stop: () => ctl.abort(),
    resume: () => {
      if (ctl.signal.aborted) ctl = new AbortController()
    },
    options: (downloadRoot) => ({ downloadRoot: ctl.signal.aborted ? null : downloadRoot, signal: ctl.signal })
  }
}
