import { contextBridge, ipcRenderer } from 'electron'

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
  kind: 'slide' | 'ocr-render' | 'ocr-image'
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
  role: 'content' | 'all'
  cluster: boolean
}
export type CategoryCount = { category: string; count: number }

const api = {
  archive: {
    // Is the Core A (ppt-archive) extraction store present?
    available: (): Promise<boolean> => ipcRenderer.invoke('archive:available'),
    // Slide + OCR search with filters; returns clusters (size-1 clusters when clustering is off).
    search: (query: string, filters: SearchFilters): Promise<SlideClusterResult[]> =>
      ipcRenderer.invoke('archive:search', query, filters),
    // Distinct deck categories (with counts) for the Category filter.
    categories: (): Promise<CategoryCount[]> => ipcRenderer.invoke('archive:categories'),
    // The structured content (presentation.json node) of one slide — for "Copy structure".
    slideStructure: (deck: string, slideOrder: number | null): Promise<string | null> =>
      ipcRenderer.invoke('archive:slide-structure', deck, slideOrder),
    // Copy the render's WebP file to the clipboard (TalkWeaver keeps it as-is, no PNG round-trip).
    copyImage: (deck: string, slideOrder: number | null): Promise<boolean> =>
      ipcRenderer.invoke('clipboard:copy-image', deck, slideOrder),
    // Copy as a PNG raster bitmap (for Keynote / Slack / web).
    copyImagePng: (deck: string, slideOrder: number | null): Promise<boolean> =>
      ipcRenderer.invoke('clipboard:copy-image-png', deck, slideOrder),
    // Reveal a slide's render in Finder ("open containing deck").
    reveal: (deck: string, slideOrder: number | null): Promise<boolean> =>
      ipcRenderer.invoke('shell:reveal', deck, slideOrder)
  },
  settings: {
    getPaths: (): Promise<{
      archiveRoot: string | null
      archiveDefault: string
      archiveAvailable: boolean
    }> => ipcRenderer.invoke('settings:get-paths'),
    chooseArchive: (): Promise<string | null> => ipcRenderer.invoke('settings:choose-archive')
  },
  shell: {
    openPath: (path: string): Promise<boolean> => ipcRenderer.invoke('shell:open-path', path),
    openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('shell:open-external', url)
  }
}

contextBridge.exposeInMainWorld('sw', api)

declare global {
  interface Window {
    sw: typeof api
  }
}

export type SwApi = typeof api
