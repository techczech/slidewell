import type { SwApi } from '../../preload'

// Browser/dev mock for window.sw so the renderer runs under plain Vite (no Electron).
// Mirrors the preload contract; returns inert values. Never used in the packaged app.
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
      scanVault: async () => 0
    },
    settings: {
      getPaths: async () => ({
        archiveRoot: null,
        archiveDefault: '~/gitrepos/05_ppt-tools/ppt-archive',
        archiveAvailable: false,
        wellRoot: '~/gitrepos/05_ppt-tools/ppt-archive/well',
        vaultRoot: null,
        vaultAvailable: false
      }),
      chooseArchive: async () => null,
      chooseVault: async () => null
    },
    shell: {
      openPath: async () => false,
      openExternal: async () => false
    },
    ingest: {
      pending: async () => ({ ok: false }),
      importPath: async () => ({ ok: false }),
      cancel: async () => true,
      onLine: () => () => {}
    }
  }
  ;(window as unknown as { sw: SwApi }).sw = mock
}
