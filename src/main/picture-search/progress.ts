/**
 * Indexing progress and resume, as pure functions (no Electron, no disk).
 *
 * Resume needs no checkpoint file: the store itself is the record of what is done. `planQueue`
 * compares the images that exist now with the fingerprints (size + mtime) already in the store
 * (embedded or failed); everything else is still to do. A restart mid-run therefore picks up exactly
 * where it stopped, and a changed file is embedded again.
 */
import type { Fingerprint, IndexItem } from './vector-store'

export type IndexPhase = 'idle' | 'indexing' | 'paused' | 'done' | 'error'

export type IndexProgress = {
  phase: IndexPhase
  done: number
  total: number
  failed: number
  secondsLeft: number | null
  error?: string
}

export type QueuePlan = { todo: IndexItem[]; done: number; total: number }

/** What is left to embed. Well images go first so new arrivals are not stuck behind the archive. */
export function planQueue(items: IndexItem[], handled: Map<string, Fingerprint>): QueuePlan {
  const seen = new Set<string>()
  const todo: IndexItem[] = []
  let done = 0
  for (const it of items) {
    if (seen.has(it.id)) continue
    seen.add(it.id)
    const fp = handled.get(it.id)
    if (fp && fp.size === it.size && fp.mtimeMs === Math.round(it.mtimeMs)) done++
    else todo.push(it)
  }
  todo.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'well-image' ? -1 : 1))
  return { todo, done, total: seen.size }
}

/** Seconds per image over the last `window` images (first image excluded: it includes warm-up). */
export class RateMeter {
  private samples: number[] = []
  private skipped = false
  constructor(private window = 30) {}
  add(seconds: number): void {
    if (!this.skipped) {
      this.skipped = true
      return
    }
    if (!Number.isFinite(seconds) || seconds < 0) return
    this.samples.push(seconds)
    if (this.samples.length > this.window) this.samples.shift()
  }
  perItem(): number | null {
    if (this.samples.length === 0) return null
    return this.samples.reduce((a, b) => a + b, 0) / this.samples.length
  }
}

export function etaSeconds(remaining: number, perItem: number | null): number | null {
  if (perItem === null || remaining <= 0) return remaining <= 0 ? 0 : null
  return remaining * perItem
}

export function formatEta(seconds: number | null): string {
  if (seconds === null) return 'estimating time left'
  if (seconds >= 3600) return `about ${Math.round(seconds / 3600)} h left`
  if (seconds >= 60) return `about ${Math.round(seconds / 60)} min left`
  return 'less than a minute left'
}

const n = (x: number): string => x.toLocaleString('en-GB')

/** The status-bar words for the current progress (frame S3). The Pause/Resume button is separate. */
export function statusText(p: IndexProgress): string {
  switch (p.phase) {
    case 'indexing':
      return `picture search: indexing ${n(p.done)} / ${n(p.total)} · ${formatEta(p.secondsLeft)}`
    case 'paused':
      return `picture search: paused at ${n(p.done)} / ${n(p.total)}`
    case 'done':
      return `picture search: ${n(p.done)} indexed${p.failed ? ` · ${n(p.failed)} could not be read` : ''}`
    case 'error':
      return `picture search: stopped — ${p.error ?? 'error'}`
    default:
      return ''
  }
}

/**
 * Settings (frame S2) estimate before anything is downloaded: the spike measured 0.27 s per slide on
 * WebGPU (0.22 s GPU-only); a range keeps it honest across Macs.
 */
export function estimateText(count: number, lowSecs = 0.23, highSecs = 0.3): string {
  const lo = count * lowSecs
  const hi = count * highSecs
  if (hi < 60) return 'under a minute'
  if (hi < 3600) return `about ${Math.max(1, Math.round(hi / 60))} minutes`
  const a = Math.max(1, Math.round(lo / 3600))
  const b = Math.max(a, Math.round(hi / 3600))
  return a === b ? `about ${a} hour${a === 1 ? '' : 's'}` : `about ${a}–${b} hours`
}

/** Share of items with meaning results so far, as a whole percentage (S3 note). */
export function coveragePercent(p: { done: number; total: number }): number {
  return p.total > 0 ? Math.floor((p.done / p.total) * 100) : 0
}
