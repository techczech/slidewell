import type { SwApi } from '../../preload'

// Browser/dev mock for window.sw so the renderer runs under plain Vite (no Electron).
// Mirrors the preload contract; returns inert values. Never used in the packaged app.
export function installMock(): void {
  const mock: SwApi = {
    archive: {
      available: async () => false,
      search: async () => [],
      categories: async () => [],
      slideStructure: async () => null,
      copyImage: async () => false,
      copyImagePng: async () => false,
      reveal: async () => false
    },
    settings: {
      getPaths: async () => ({
        archiveRoot: null,
        archiveDefault: '~/gitrepos/05_ppt-tools/ppt-archive',
        archiveAvailable: false
      }),
      chooseArchive: async () => null
    },
    shell: {
      openPath: async () => false,
      openExternal: async () => false
    }
  }
  ;(window as unknown as { sw: SwApi }).sw = mock
}
