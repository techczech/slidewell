/**
 * The background indexing loop. It plans from the store (see progress.ts), embeds one image at a
 * time, and stops cleanly between images on pause or stop. `poke()` re-plans after new images
 * arrive (well imports, archive ingest), so they are embedded without a restart. Pausing is the
 * caller's to persist; on the next launch the caller simply does not call `start()` while paused.
 */
import { planQueue, RateMeter, etaSeconds, type IndexProgress } from './progress'
import type { Fingerprint, IndexItem } from './vector-store'

export type IndexerDeps = {
  /** Every image that should have a vector now. */
  enumerate: () => Promise<IndexItem[]>
  /** What the store already holds (embedded or failed). */
  handled: () => Map<string, Fingerprint>
  failedCount: () => number
  /** Embed one image and store it. */
  embed: (item: IndexItem) => Promise<void>
  /** True when an embed error is about this image (record it, go on); false = engine failure (stop). */
  isItemFailure: (e: unknown) => boolean
  recordFailure: (item: IndexItem, error: string) => void
  onProgress: (p: IndexProgress) => void
  /** Called once when the loop goes idle (done, paused, stopped) — e.g. to free the GPU model. */
  onIdle?: () => void
  now?: () => number
  /** Minimum ms between progress events while indexing (the first and last always fire). */
  progressEveryMs?: number
}

export class Indexer {
  private running = false
  private paused = false
  private stopped = false
  private repoke = false
  private progress: IndexProgress = { phase: 'idle', done: 0, total: 0, failed: 0, secondsLeft: null }
  private lastEmit = 0
  private loop: Promise<void> | null = null

  constructor(private deps: IndexerDeps) {}

  state(): IndexProgress {
    return { ...this.progress }
  }

  isPaused(): boolean {
    return this.paused
  }

  /** Start (or resume) the loop. Returns when the current pass finishes or pauses. */
  start(): Promise<void> {
    this.paused = false
    this.stopped = false
    if (this.loop) {
      this.repoke = true
      return this.loop
    }
    this.loop = this.run().finally(() => {
      this.loop = null
    })
    return this.loop
  }

  /** Stop after the image in flight; progress shows 'paused'. */
  async pause(): Promise<void> {
    this.paused = true
    if (this.loop) {
      await this.loop
      return
    }
    // Not running (e.g. launched while paused): plan only, to show "paused at N / M".
    try {
      const plan = planQueue(await this.deps.enumerate(), this.deps.handled())
      if (this.paused) this.emit({ phase: 'paused', done: plan.done, total: plan.total, failed: this.deps.failedCount(), secondsLeft: null }, true)
    } catch (e) {
      this.emit({ ...this.progress, phase: 'error', error: (e as Error)?.message ?? String(e), secondsLeft: null }, true)
    }
  }

  /** Stop after the image in flight; progress goes back to idle (model deleted / feature off). */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.loop) await this.loop
    this.emit({ phase: 'idle', done: 0, total: 0, failed: 0, secondsLeft: null }, true)
  }

  /** New images may exist: re-plan (starts the loop again; while paused only the counts update). */
  poke(): void {
    if (this.stopped) return
    if (this.paused) {
      if (!this.loop) void this.pause() // refresh "paused at N / M" without embedding
      return
    }
    if (this.loop) this.repoke = true
    else void this.start()
  }

  private emit(p: IndexProgress, force = false): void {
    this.progress = p
    const now = (this.deps.now ?? Date.now)()
    if (!force && now - this.lastEmit < (this.deps.progressEveryMs ?? 500)) return
    this.lastEmit = now
    this.deps.onProgress({ ...p })
  }

  private async run(): Promise<void> {
    const now = this.deps.now ?? Date.now
    const meter = new RateMeter()
    try {
      do {
        this.repoke = false
        const plan = planQueue(await this.deps.enumerate(), this.deps.handled())
        let done = plan.done
        const failedBase = this.deps.failedCount()
        let failed = failedBase
        this.emit({ phase: plan.todo.length ? 'indexing' : 'done', done, total: plan.total, failed, secondsLeft: plan.todo.length ? null : 0 }, true)
        for (const item of plan.todo) {
          if (this.paused || this.stopped || this.repoke) break
          const t0 = now()
          try {
            await this.deps.embed(item)
          } catch (e) {
            if (!this.deps.isItemFailure(e)) throw e
            this.deps.recordFailure(item, (e as Error)?.message ?? String(e))
            failed++
          }
          meter.add((now() - t0) / 1000)
          done++
          const left = plan.total - done
          this.emit({ phase: left > 0 ? 'indexing' : 'done', done, total: plan.total, failed, secondsLeft: etaSeconds(left, meter.perItem()) }, left === 0)
        }
        if (this.paused) {
          this.emit({ ...this.progress, phase: 'paused', secondsLeft: null }, true)
          break
        }
        if (this.stopped) break
        if (!this.repoke) this.emit({ ...this.progress, phase: 'done', secondsLeft: 0 }, true)
      } while (this.repoke && !this.paused && !this.stopped)
    } catch (e) {
      this.emit({ ...this.progress, phase: 'error', error: (e as Error)?.message ?? String(e), secondsLeft: null }, true)
    } finally {
      this.deps.onIdle?.()
    }
  }
}
