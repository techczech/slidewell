import type { SwApi } from '../../preload'

// Browser/dev mock for window.sw so the renderer runs under plain Vite (no Electron).
// Mirrors the full preload contract; returns inert values. Never used in the packaged app.
export function installMock(): void {
  const pictureStatus = {
    model: 'absent' as const,
    modelBytes: 910310138,
    download: null,
    error: null,
    includeWell: true,
    paused: false,
    index: { phase: 'idle' as const, done: 0, total: 0, failed: 0, secondsLeft: null },
    text: '',
    coverage: 0,
    estimate: null
  }
  const mock: SwApi = {
    picture: {
      status: async () => pictureStatus,
      estimate: async () => null,
      download: async () => ({ ok: false, error: 'not available in the browser preview' }),
      cancelDownload: async () => undefined,
      deleteModel: async () => undefined,
      pause: async () => undefined,
      resume: async () => undefined,
      setIncludeWell: async () => undefined,
      query: async () => ({ ok: false, results: [], error: 'not available in the browser preview' }),
      queryCount: async () => 0,
      onStatus: () => () => undefined
    },
    archive: {
      available: async () => false,
      search: async () => [],
      searchMatched: async (_q: string, _f: unknown, mode: 'words' | 'meaning' | 'both') => ({ requested: mode, mode: 'words' as const, modelReady: false, words: [], related: [], pictureError: null, ms: { words: 0, meaning: null } }),
      fromCounts: async () => ({ all: 0, screenshots: 0, 'old-images': 0, 'old-slides': 0, talks: 0 }),
      categories: async () => [],
      decks: async () => [],
      listDecks: async () => [],
      deckDetail: async () => null,
      stats: async () => null,
      slideStructure: async () => null,
      slideImages: async () => [],
      deckSlides: async () => [],
      copyImage: async () => false,
      copyImagePng: async () => false,
      reveal: async () => false,
      scanVault: async () => 0,
      deleteOthersMatching: async () => ({ ok: false })
    },
    settings: {
      getPaths: async () => ({
        archiveRoot: null,
        archiveDefault: '~/ppt-archive',
        archiveAvailable: false,
        wellRoot: '~/ppt-archive/well',
        vaultRoot: null,
        vaultAvailable: false,
        screenshotRoot: null,
        screenshotAvailable: false,
        captureSources: [],
        captureDefaults: { desktop: { path: '~/Desktop', namedOnly: true }, cleanshot: null },
        conversionsRoot: null,
        convertOcrDefault: false,
        othersArchiveRoot: '~/SlideWell/others-library',
        othersArchiveAvailable: false
      }),
      chooseArchive: async () => null,
      chooseVault: async () => null,
      addCaptureSource: async () => false,
      removeCaptureSource: async () => true,
      chooseScreenshotFolder: async () => null,
      chooseConversionsFolder: async () => null,
      setConvertOcr: async (on: boolean) => on,
      getOwnerNames: async () => ({ names: ['Mock User'], isDefault: true }),
      setOwnerNames: async (names: string[]) => ({ names, isDefault: names.length === 0 }),
      chooseOthersFolder: async () => null,
      clearOthersLibrary: async () => ({ ok: false }),
      getR2: async () => ({ accountId: '', endpoint: '', bucket: 'ppt-archive-media', prefix: 'slidewell', hasCreds: false }),
      setR2: async () => ({ ok: true, gotKeys: false, encAvailable: false, savedCreds: false }),
      testR2: async () => ({ ok: false, error: 'mock' }),
      getStorage: async () => ({ archive: 'local' as const, others: 'local' as const, well: 'local' as const }),
      setStoreBackend: async () => ({ ok: true }),
      syncStore: async () => ({ ok: false, error: 'mock' }),
      dependencies: async () => ({ requirementsUrl: '', deps: [] })
    },
    triage: {
      scan: async () => ({ ok: false, indexed: 0, total: 0, offline: 0 }),
      list: async () => ({ items: [], counts: { undecided: 0, included: 0, excluded: 0, total: 0 }, hasMore: false }),
      decide: async () => ({ state: 'undecided' }),
      paste: async () => null,
      onProgress: () => () => {},
      onChanged: () => () => {}
    },
    shell: {
      openPath: async () => false,
      openExternal: async () => false
    },
    ingest: {
      pending: async () => ({ ok: false }),
      choosePath: async () => null,
      runPath: async () => ({ ok: false }),
      cancel: async () => true,
      onLine: () => () => {}
    },
    convert: {
      chooseSource: async () => null,
      chooseDest: async () => null,
      run: async () => ({ ok: false }),
      onLine: () => () => {}
    }
  }
  ;(window as unknown as { sw: SwApi }).sw = mock
}
