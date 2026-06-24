import type { SwApi } from '../../preload'

// Browser/dev mock for window.sw so the renderer runs under plain Vite (no Electron).
// Mirrors the full preload contract; returns inert values. Never used in the packaged app.
export function installMock(): void {
  const mock: SwApi = {
    archive: {
      available: async () => false,
      search: async () => [],
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
        archiveDefault: '~/gitrepos/05_ppt-tools/ppt-archive',
        archiveAvailable: false,
        wellRoot: '~/gitrepos/05_ppt-tools/ppt-archive/well',
        vaultRoot: null,
        vaultAvailable: false,
        screenshotRoot: null,
        screenshotAvailable: false,
        conversionsRoot: null,
        convertOcrDefault: false,
        othersArchiveRoot: '~/SlideWell/others-library',
        othersArchiveAvailable: false
      }),
      chooseArchive: async () => null,
      chooseVault: async () => null,
      chooseScreenshotFolder: async () => null,
      chooseConversionsFolder: async () => null,
      setConvertOcr: async (on: boolean) => on,
      chooseOthersFolder: async () => null,
      clearOthersLibrary: async () => ({ ok: false }),
      getR2: async () => ({ accountId: '', endpoint: '', bucket: 'ppt-archive-media', prefix: 'slidewell', hasCreds: false }),
      setR2: async () => ({ ok: true, gotKeys: false, encAvailable: false, savedCreds: false }),
      testR2: async () => ({ ok: false, error: 'mock' }),
      dependencies: async () => ({ requirementsUrl: '', deps: [] })
    },
    triage: {
      scan: async () => ({ ok: false, indexed: 0, total: 0, offline: 0 }),
      list: async () => ({ items: [], counts: { undecided: 0, included: 0, excluded: 0, total: 0 }, hasMore: false }),
      decide: async () => ({ state: 'undecided' }),
      paste: async () => null,
      onProgress: () => () => {}
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
