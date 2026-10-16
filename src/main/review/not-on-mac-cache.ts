/**
 * Which screenshots in Review are not on this Mac (their picture is a cloud placeholder), without holding the main process
 * on one long run of file checks. The answer for one screenshot comes from Review's picture chooser (picture.ts), which
 * checks its copies on disk (real path and stat, synchronously). Over every screenshot in Review that is thousands of
 * checks, and Review's overview needs it on each read for the Not on this Mac count and for "leave them out".
 *
 *   notHere(items, choose) → the hashes among `items` whose picture is not on this Mac
 *   invalidate()           → forget every answer (a scan, a download, files that came down)
 *
 * Small interface; behind it: an answer per hash is kept for TTL_MS (60 s) together with a fingerprint of the copies
 * the scan recorded for it (paths, kinds, the row's offline flag), so a re-scan that changed a row is looked at again at
 * once; the rest are checked in batches of BATCH (200), yielding to the event loop (setImmediate) between batches, so
 * IPC, windows and timers keep running while a large Review is checked.
 *
 * What it gives up: a file downloaded outside SlideWell is seen at the next scan, the next Download them, or within 60 s.
 */
import type { PictureChoice } from './picture'
import type { ReviewFile } from './store'

export const TTL_MS = 60_000
export const BATCH = 200

type Entry = { at: number; key: string; notHere: boolean }
type Item = { hash: string; copies: ReviewFile[] }

export type NotOnMacCacheDeps = {
  now?: () => number
  /** Hand the event loop a turn between batches. Default: setImmediate. */
  yieldNow?: () => Promise<void>
}

const fingerprint = (copies: ReviewFile[]): string => copies.map((c) => `${c.source}\u0000${c.relPath}\u0000${c.kind}\u0000${c.offline ? 1 : 0}\u0000${c.posterRel}`).join('\u0001')

export class NotOnMacCache {
  private entries = new Map<string, Entry>()
  /** Bumped by invalidate(): a check that was running when it came does not store what it found. */
  private epoch = 0

  constructor(private deps: NotOnMacCacheDeps = {}) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private yieldNow(): Promise<void> {
    return this.deps.yieldNow ? this.deps.yieldNow() : new Promise((r) => setImmediate(r))
  }

  invalidate(): void {
    this.entries.clear()
    this.epoch++
  }

  /** The hashes among `items` whose picture is not on this Mac (`choose` is one read's picture chooser). */
  async notHere(items: Item[], choose: (hash: string, copies: ReviewFile[]) => PictureChoice): Promise<Set<string>> {
    const out = new Set<string>()
    const now = this.now()
    const epoch = this.epoch
    let checked = 0
    for (const i of items) {
      const key = fingerprint(i.copies)
      const hit = this.entries.get(i.hash)
      let away: boolean
      if (hit && hit.key === key && now - hit.at < TTL_MS) away = hit.notHere
      else {
        if (checked > 0 && checked % BATCH === 0) await this.yieldNow()
        checked++
        away = choose(i.hash, i.copies).state === 'not-downloaded'
        if (this.epoch === epoch) this.entries.set(i.hash, { at: now, key, notHere: away })
      }
      if (away) out.add(i.hash)
    }
    // hashes no longer in Review are dropped, so the map never outgrows Review
    if (this.entries.size > items.length * 2 + BATCH) {
      const live = new Set(items.map((i) => i.hash))
      for (const h of this.entries.keys()) if (!live.has(h)) this.entries.delete(h)
    }
    return out
  }
}
