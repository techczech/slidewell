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

// Search result shapes (the main process resolves render/image paths to swarchive:// URLs).
export type SlideResult = {
  kind: 'slide' | 'ocr-render' | 'ocr-image'
  title: string
  snippet: string
  deck: string
  slideOrder: number | null
  usedInDecks: number
  reference: string // `[use: ppt:<id>#<order>]`
  thumbUrl: string | null
}
export type ImageResult = {
  sha256: string
  deck: string
  format: string
  snippet: string
  usedInDecks: number
  reference: string // `r2://ppt-archive-media/media/<sha>.<ext>`
  thumbUrl: string | null
}

const api = {
  archive: {
    // Is the Core A (ppt-archive) extraction store present? Search degrades to FTS-only when not.
    available: (): Promise<boolean> => ipcRenderer.invoke('archive:available'),
    // Slide text + OCR search (FTS5) over the archive; [] when the archive is absent.
    searchSlides: (query: string): Promise<SlideResult[]> => ipcRenderer.invoke('archive:search-slides', query),
    // Extracted-image search by OCR text (media.db).
    searchImages: (query: string): Promise<ImageResult[]> => ipcRenderer.invoke('archive:search-images', query)
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
