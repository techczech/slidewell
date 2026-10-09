/**
 * Picture search as one service for the main process: model download/delete, the background
 * indexer, pause/resume (persisted), and the query function. index.ts creates it once, registers the
 * IPC below, and pokes it when new images arrive. Nothing here makes a network call until
 * `download()` runs (the user pressed Download in Settings).
 */
import { ipcMain } from 'electron'
import { join } from 'node:path'
import { MODEL_DIM, MODEL_REPO, MODEL_REVISION, MODEL_TOTAL_BYTES, QUERY_PREFIX } from './model-manifest'
import { bytesOnDisk, deleteModel, downloadModel, modelDir, modelState, type FetchLike } from './model-store'
import { PictureSearchEngine, UnreadableImageError, type Embedder, type PictureQuery, type QueryOptions, type Scored } from './engine'
import { Indexer } from './indexer'
import { coveragePercent, estimateText, statusText, type IndexProgress } from './progress'
import { archiveRenders, wellImages } from './sources'
import { STORE_FILE, VectorStore, type IndexItem } from './vector-store'

export type PictureSearchSettings = { includeWell?: boolean; paused?: boolean }

export type PictureSearchStatus = {
  model: 'absent' | 'partial' | 'downloading' | 'ready'
  modelBytes: number
  download: { receivedBytes: number; totalBytes: number } | null
  error: string | null
  includeWell: boolean
  paused: boolean
  index: IndexProgress
  /** Status-bar words (frame S3), '' when there is nothing to show. */
  text: string
  coverage: number
  /** Settings note (frame S2): how many images and roughly how long. */
  estimate: { slides: number; wellImages: number; text: string } | null
}

export type PictureSearchDeps = {
  modelsRoot: string
  wellRoot: () => string
  archiveRoot: () => string | null
  vaultRoot: () => string | null
  settings: () => PictureSearchSettings
  saveSettings: (patch: PictureSearchSettings) => void
  fetch: FetchLike
  /** Builds the real embedder (the hidden WebGPU window) for a verified model folder. */
  makeEmbedder: (modelDir: string) => Embedder & { releaseVision?: () => Promise<void>; dispose?: () => void }
  broadcast: (s: PictureSearchStatus) => void
}

export class PictureSearchService {
  private store: VectorStore | null = null
  private engine: PictureSearchEngine | null = null
  private embedder: ReturnType<PictureSearchDeps['makeEmbedder']> | null = null
  private indexer: Indexer
  private archiveCache: { root: string | null; items: IndexItem[] } | null = null
  private estimateCache: PictureSearchStatus['estimate'] = null
  private downloading: AbortController | null = null
  private download: PictureSearchStatus['download'] = null
  private error: string | null = null
  private lastBroadcast = 0

  constructor(private deps: PictureSearchDeps) {
    this.indexer = new Indexer({
      enumerate: () => this.enumerate(),
      handled: () => this.openStore().fingerprints(),
      failedCount: () => this.openStore().failedCount(),
      embed: (item) => this.openEngine().embedAndStore(item),
      isItemFailure: (e) => e instanceof UnreadableImageError,
      recordFailure: (item, err) => {
        this.openStore().putFailure(item, err)
        this.engine?.forget(item.id)
      },
      onProgress: () => this.push(true),
      onIdle: () => void this.embedder?.releaseVision?.().catch(() => undefined)
    })
  }

  private dir(): string {
    return modelDir(this.deps.modelsRoot)
  }

  private includeWell(): boolean {
    return this.deps.settings().includeWell !== false // on by default (picture-search decisions)
  }

  private openStore(): VectorStore {
    if (!this.store) {
      this.store = new VectorStore(join(this.deps.wellRoot(), STORE_FILE), {
        model: MODEL_REPO,
        model_revision: MODEL_REVISION,
        model_dtype: 'fp16',
        dim: String(MODEL_DIM),
        vector_format: 'float32-le, L2-normalised (cosine = dot product)',
        query_prefix: QUERY_PREFIX
      })
    }
    return this.store
  }

  private openEngine(): PictureSearchEngine {
    if (!this.engine) {
      this.engine = new PictureSearchEngine(this.openStore(), () => {
        if (modelState(this.dir()) !== 'ready') return null
        if (!this.embedder) this.embedder = this.deps.makeEmbedder(this.dir())
        return this.embedder
      })
    }
    return this.engine
  }

  /** Slide rows belong to one archive root; a different root drops them (store and memory). */
  private bindArchive(root: string | null): void {
    if (!root) return
    for (const id of this.openStore().useArchiveRoot(root)) this.engine?.forget(id)
  }

  private async enumerate(): Promise<IndexItem[]> {
    const root = this.deps.archiveRoot()
    // keyed by root: pointing Settings at another archive folder enumerates that one, and the slide
    // vectors made from the old archive are dropped (an unavailable archive drops nothing)
    this.bindArchive(root)
    if (!this.archiveCache || this.archiveCache.root !== root) this.archiveCache = { root, items: root ? await archiveRenders(root) : [] }
    const well = this.includeWell() ? await wellImages(this.deps.wellRoot(), this.deps.vaultRoot()) : []
    return [...well, ...this.archiveCache.items]
  }

  status(): PictureSearchStatus {
    const st = modelState(this.dir())
    const index = this.indexer.state()
    const paused = Boolean(this.deps.settings().paused)
    const shown: IndexProgress = index
    return {
      model: this.downloading ? 'downloading' : st,
      modelBytes: MODEL_TOTAL_BYTES,
      download: this.downloading ? this.download : st === 'partial' ? { receivedBytes: bytesOnDisk(this.dir()), totalBytes: MODEL_TOTAL_BYTES } : null,
      error: this.error,
      includeWell: this.includeWell(),
      paused,
      index: shown,
      text: st === 'ready' ? statusText(shown) : '',
      coverage: coveragePercent(shown),
      estimate: this.estimateCache
    }
  }

  private push(force = false): void {
    const now = Date.now()
    if (!force && now - this.lastBroadcast < 250) return
    this.lastBroadcast = now
    this.deps.broadcast(this.status())
  }

  /** Count what would be indexed (local disk only) for the Settings note. */
  async estimate(): Promise<PictureSearchStatus['estimate']> {
    const items = await this.enumerate()
    const slides = items.filter((i) => i.kind === 'slide').length
    const well = items.length - slides
    this.estimateCache = { slides, wellImages: well, text: estimateText(items.length) }
    return this.estimateCache
  }

  /** On launch: if the model is ready and indexing is not paused, carry on where it stopped. */
  start(): void {
    if (modelState(this.dir()) === 'ready' && !this.deps.settings().paused) void this.indexer.start()
    else if (modelState(this.dir()) === 'ready') void this.indexer.pause()
  }

  /** Download + verify the model, then start indexing. Resolves when the download ends. */
  async downloadModel(): Promise<{ ok: boolean; error?: string }> {
    if (this.downloading) return { ok: false, error: 'already downloading' }
    if (modelState(this.dir()) === 'ready') {
      this.start()
      return { ok: true }
    }
    const ctl = new AbortController()
    this.downloading = ctl
    this.error = null
    this.download = { receivedBytes: bytesOnDisk(this.dir()), totalBytes: MODEL_TOTAL_BYTES }
    this.push(true)
    try {
      await downloadModel(this.dir(), this.deps.fetch, {
        signal: ctl.signal,
        onProgress: (p) => {
          this.download = { receivedBytes: p.receivedBytes, totalBytes: p.totalBytes }
          this.push()
        }
      })
      if (ctl.signal.aborted) throw new Error('download cancelled') // cancelled at the last moment: do not switch on
      this.downloading = null
      this.deps.saveSettings({ paused: false })
      this.push(true)
      void this.indexer.start()
      return { ok: true }
    } catch (e) {
      this.downloading = null
      const msg = ctl.signal.aborted ? null : (e as Error)?.message ?? String(e)
      this.error = msg
      this.push(true)
      return { ok: false, error: msg ?? 'cancelled' }
    }
  }

  cancelDownload(): void {
    this.downloading?.abort()
  }

  /** Delete the model files. Indexing stops; vectors already in the store are kept. */
  async deleteModel(): Promise<void> {
    this.cancelDownload()
    await this.indexer.stop()
    this.embedder?.dispose?.()
    this.embedder = null
    deleteModel(this.dir())
    this.error = null
    this.push(true)
  }

  async pause(): Promise<void> {
    this.deps.saveSettings({ paused: true })
    await this.indexer.pause()
    this.push(true)
  }

  resume(): void {
    this.deps.saveSettings({ paused: false })
    if (modelState(this.dir()) === 'ready') void this.indexer.start()
    this.push(true)
  }

  async setIncludeWell(on: boolean): Promise<void> {
    this.deps.saveSettings({ includeWell: on })
    this.estimateCache = null
    this.poke()
    this.push(true)
  }

  /** New well images may exist (import, paste, vault scan). */
  poke(): void {
    if (modelState(this.dir()) === 'ready') this.indexer.poke()
  }

  /** The archive changed (ingest): enumerate its renders again. */
  pokeArchive(): void {
    if (modelState(this.dir()) === 'ready' || this.store) this.bindArchive(this.deps.archiveRoot())
    this.archiveCache = null
    this.estimateCache = null
    this.poke()
  }

  /** The main-process query: text → ranked ids, or a stored image id → similar ids. Scores are cosines. */
  pictureQuery(q: PictureQuery, opts?: QueryOptions): Promise<Scored[]> {
    return this.openEngine().pictureQuery(q, opts)
  }

  dispose(): void {
    this.cancelDownload()
    void this.indexer.stop()
    this.embedder?.dispose?.()
    this.store?.close()
  }
}

/** IPC for Settings, the status bar and (ticket 04) the search surface. Types: src/preload/index.ts. */
export function registerPictureSearchIpc(svc: PictureSearchService, allowed: (sender: Electron.WebContents) => boolean): void {
  const handle = (channel: string, fn: (...args: any[]) => unknown): void => { // eslint-disable-line @typescript-eslint/no-explicit-any
    ipcMain.handle(channel, (e, ...args) => {
      if (!allowed(e.sender)) throw new Error(`${channel}: not allowed from this window`)
      return fn(...args)
    })
  }
  handle('picture:status', () => svc.status())
  handle('picture:estimate', () => svc.estimate())
  handle('picture:download', () => svc.downloadModel())
  handle('picture:cancel-download', () => svc.cancelDownload())
  handle('picture:delete-model', () => svc.deleteModel())
  handle('picture:pause', () => svc.pause())
  handle('picture:resume', () => svc.resume())
  handle('picture:set-include-well', (on: boolean) => svc.setIncludeWell(Boolean(on)))
  handle('picture:query', async (q: PictureQuery, opts?: QueryOptions) => {
    try {
      return { ok: true, results: await svc.pictureQuery(q, opts) }
    } catch (e) {
      return { ok: false, results: [], error: (e as Error)?.message ?? String(e) }
    }
  })
}
