import { contextBridge, ipcRenderer } from 'electron'
import type { Stats } from '../main/stats'

export type { Stats } from '../main/stats'

// One Image Node entity is shared with TalkWeaver (CONTEXT.md / ADR-0020, ADR-0026): a
// content-addressed image + sidecar. In SlideWell it also carries provenance + notes. On disk
// the file is named `{slug}--{id}.ext` (ADR-0026) so the store is discoverable without this app;
// the resolver matches on the hash portion, never the slug.
export type ImageProvenance = 'extracted' | 'added'

export type ImageNode = {
  id: string // 7-char sha256 — the stable identity used in `img-{id}` references
  slug: string // human-readable, frozen-at-creation filename anchor (may be '')
  ext: string
  provenance: ImageProvenance
  source?: string // deck slug (extracted) or import note (added)
  alt: string
  caption: string
  tags: string[]
  notes: string
  /** swarchive://<b64url> | swasset://<id> — a renderable thumbnail URL. */
  thumbUrl: string
}

// Search result shapes (the main process resolves render paths to swarchive:// URLs).
export type SlideResult = {
  kind: 'slide' | 'ocr-render' | 'ocr-image' | 'well-image' | 'archive-image'
  title: string
  snippet: string
  text: string
  rank: number
  deck: string
  deckTitle: string
  filename: string
  category: string
  date: string | null
  slideOrder: number | null
  usedInDecks: number
  reference: string // `[use: ppt:<id>#<order>]`
  thumbUrl: string | null
}
export type SlideClusterResult = {
  representative: SlideResult
  members: SlideResult[]
  size: number
  deckCount: number
}
export type SearchFilters = {
  owner: 'mine' | 'all' | 'others' | 'unknown'
  era: string // 'all' | 'recent' | 'mid' | 'early' | a year like '2024'
  category: string // '' = all categories
  deck: string // '' = any deck; else a deck name/substring
  role: 'content' | 'all'
  cluster: boolean
  scope: 'all' | 'archive' | 'well'
  type: 'slides' | 'images' | 'decks'
}
export type CategoryCount = { category: string; count: number }
// An external tool SlideWell depends on, with detected presence — shown in Settings (REQUIREMENTS.md).
export type Dependency = {
  key: string
  label: string
  found: boolean
  detail: string
  requiredFor: string
  install: string
  required: boolean
}
// A scanned item in a Triage source (ADR-0029) — not yet in the library unless state==='included'.
export type TriageItem = {
  hash: string // content hash — the DECISION key; repeats across duplicate files (not unique)
  relPath: string // source-relative path — unique per file; use as the React key
  kind: 'image' | 'video'
  filename: string
  ext: string
  state: 'undecided' | 'included' | 'excluded'
  offline: boolean // OneDrive online-only placeholder — not downloaded, so not read/thumbnailed
  mtime: number // file modified time (epoch ms) — capture time, for sort/group by date
  date: string // YYYY-MM-DD derived from mtime
  sizeMB: number
  large: boolean // video over the 20 MB gate — include needs an explicit confirm
  snippet: string
  thumbUrl: string | null
  mediaUrl: string | null // video source file (for inline playback); null for images
}
export type TriageCounts = { undecided: number; included: number; excluded: number; total: number }
export type DeckInfo = { id: string; title: string; date: string | null }
export type DeckCard = {
  id: string
  title: string
  date: string | null
  category: string
  filename: string
  ownership: string
  slideCount: number
  coverThumbUrl: string | null
}
export type DeckDetail = {
  id: string
  title: string
  date: string | null
  dateSource: string
  category: string
  filename: string
  ownership: string
  sourcePath: string
  sectionCount: number
  slideCount: number
}

const api = {
  archive: {
    // Is the Core A (ppt-archive) extraction store present?
    available: (): Promise<boolean> => ipcRenderer.invoke('archive:available'),
    // Slide + OCR search with filters; returns clusters (size-1 clusters when clustering is off).
    search: (query: string, filters: SearchFilters): Promise<SlideClusterResult[]> =>
      ipcRenderer.invoke('archive:search', query, filters),
    // Distinct deck categories (with counts) for the Category filter.
    categories: (): Promise<CategoryCount[]> => ipcRenderer.invoke('archive:categories'),
    // All decks (newest-first) for the Deck filter picker.
    decks: (): Promise<DeckInfo[]> => ipcRenderer.invoke('archive:decks'),
    // Deck MODE: one card per presentation (title-slide cover).
    listDecks: (filters: SearchFilters): Promise<DeckCard[]> => ipcRenderer.invoke('archive:list-decks', filters),
    // Full metadata for one deck (sidebar).
    deckDetail: (pid: string): Promise<DeckDetail | null> => ipcRenderer.invoke('archive:deck-detail', pid),
    // Stats bundle (timeline of "my" PowerPoint history).
    stats: (): Promise<Stats | null> => ipcRenderer.invoke('archive:stats'),
    // The structured content (presentation.json node) of one slide — for "Copy structure" / inspector JSON.
    slideStructure: (deck: string, slideOrder: number | null): Promise<string | null> =>
      ipcRenderer.invoke('archive:slide-structure', deck, slideOrder),
    // The embedded image assets on one slide (for the inspector).
    slideImages: (deck: string, slideOrder: number | null): Promise<Array<{ thumbUrl: string | null }>> =>
      ipcRenderer.invoke('archive:slide-images', deck, slideOrder),
    // All slides of one presentation, in order — for "See in context".
    deckSlides: (deck: string): Promise<SlideResult[]> => ipcRenderer.invoke('archive:deck-slides', deck),
    // Copy an image FILE (WebP) to the clipboard (TalkWeaver keeps it as-is). Pass the hit's thumbUrl.
    copyImage: (thumbUrl: string | null): Promise<boolean> => ipcRenderer.invoke('clipboard:copy-image', thumbUrl),
    // Copy as a PNG raster bitmap (for Keynote / Slack / web). Pass the hit's thumbUrl.
    copyImagePng: (thumbUrl: string | null): Promise<boolean> => ipcRenderer.invoke('clipboard:copy-image-png', thumbUrl),
    // Reveal an image in Finder. Pass the hit's thumbUrl.
    reveal: (thumbUrl: string | null): Promise<boolean> => ipcRenderer.invoke('shell:reveal', thumbUrl),
    // Re-scan the TalkWeaver vault for new images; returns count added.
    scanVault: (): Promise<number> => ipcRenderer.invoke('well:scan-vault')
  },
  settings: {
    getPaths: (): Promise<{
      archiveRoot: string | null
      archiveDefault: string
      archiveAvailable: boolean
      wellRoot: string
      vaultRoot: string | null
      vaultAvailable: boolean
      screenshotRoot: string | null
      screenshotAvailable: boolean
      conversionsRoot: string | null
      convertOcrDefault: boolean
    }> => ipcRenderer.invoke('settings:get-paths'),
    chooseArchive: (): Promise<string | null> => ipcRenderer.invoke('settings:choose-archive'),
    chooseVault: (): Promise<string | null> => ipcRenderer.invoke('settings:choose-vault'),
    chooseScreenshotFolder: (): Promise<string | null> => ipcRenderer.invoke('settings:choose-screenshot-folder'),
    // Default destination folder for throwaway conversions (pre-fills the convert save dialog).
    chooseConversionsFolder: (): Promise<string | null> => ipcRenderer.invoke('settings:choose-conversions-folder'),
    // Persist the default state of the convert OCR toggle.
    setConvertOcr: (on: boolean): Promise<boolean> => ipcRenderer.invoke('settings:set-convert-ocr', on),
    // Detected status of external tools (engine, OCR, ffmpeg, LibreOffice…) + the Requirements URL.
    dependencies: (): Promise<{ requirementsUrl: string; deps: Dependency[] }> => ipcRenderer.invoke('settings:dependencies')
  },
  // Triage source workflow (ADR-0029): scan a folder, browse/decide, promote keepers into the well.
  triage: {
    scan: (): Promise<{ ok: boolean; indexed: number; total: number; offline: number }> => ipcRenderer.invoke('triage:scan'),
    list: (
      query: string,
      state: string,
      sort?: 'scanned' | 'date-desc' | 'date-asc',
      limit?: number,
      offset?: number
    ): Promise<{ items: TriageItem[]; counts: TriageCounts; hasMore: boolean }> => ipcRenderer.invoke('triage:list', query, state, sort, limit, offset),
    decide: (hash: string, action: 'include' | 'exclude' | 'reset', force?: boolean): Promise<{ state: string; wellId?: string; gated?: boolean; sizeMB?: number }> =>
      ipcRenderer.invoke('triage:decide', hash, action, force),
    // Paste-to-include: ingest the clipboard image straight into the well. Returns the new id or null.
    paste: (): Promise<{ id: string } | null> => ipcRenderer.invoke('well:add-from-clipboard'),
    // Stream scan progress; returns an unsubscribe function.
    onProgress: (cb: (line: string) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, line: string): void => cb(line)
      ipcRenderer.on('triage:progress', handler)
      return () => ipcRenderer.removeListener('triage:progress', handler)
    }
  },
  shell: {
    openPath: (path: string): Promise<boolean> => ipcRenderer.invoke('shell:open-path', path),
    openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('shell:open-external', url)
  },
  ingest: {
    // Run Core A's pipeline over the configured archive roots (crawl → extract → render → OCR).
    pending: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('ingest:pending'),
    // Pick a .pptx or a folder, extract + OCR just those.
    importPath: (): Promise<{ ok: boolean; cancelled?: boolean }> => ipcRenderer.invoke('ingest:import-path'),
    cancel: (): Promise<boolean> => ipcRenderer.invoke('ingest:cancel'),
    // Subscribe to streamed progress lines; returns an unsubscribe function.
    onLine: (cb: (line: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, line: string): void => cb(line)
      ipcRenderer.on('ingest:line', handler)
      return () => ipcRenderer.removeListener('ingest:line', handler)
    }
  },
  // Sideband, throwaway: convert someone else's .pptx to a mechanical Outline folder you pick.
  // Never catalogued into the archive or vault (distinct from `ingest`). Streams progress lines.
  convert: {
    pptxToOutline: (opts: { ocr: boolean }): Promise<{ ok: boolean; cancelled?: boolean; outDir?: string; error?: string }> =>
      ipcRenderer.invoke('convert:pptx-to-outline', opts),
    onLine: (cb: (line: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, line: string): void => cb(line)
      ipcRenderer.on('convert:line', handler)
      return () => ipcRenderer.removeListener('convert:line', handler)
    }
  }
}

contextBridge.exposeInMainWorld('sw', api)

declare global {
  interface Window {
    sw: typeof api
  }
}

export type SwApi = typeof api
