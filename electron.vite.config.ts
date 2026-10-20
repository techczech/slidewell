import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { build as viteBuild, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// @bridle/* are bundled (not left as node_modules files): they are linked by file: path, and electron-builder
// copies those as plain files with whatever transitive versions it finds. The Settings window is sandboxed, so
// its preload cannot require packages either.
const BUNDLED = ['@bridle/commands', '@bridle/settings', '@bridle/settings-electron', '@bridle/settings-react']

// The Settings window's preload is sandboxed: it may require nothing but electron, so it must be one file.
// Built as its own bundle after the other preloads (as a third input, rollup would split the window.sw
// bridge it shares with index.ts into a chunk the sandbox cannot load).
function settingsPreload(): Plugin {
  return {
    name: 'slidewell-settings-preload',
    apply: 'build',
    async closeBundle() {
      await viteBuild({
        configFile: false,
        logLevel: 'warn',
        build: {
          outDir: resolve(__dirname, 'out/preload'),
          emptyOutDir: false,
          minify: false,
          lib: { entry: resolve(__dirname, 'src/preload/settings.ts'), formats: ['cjs'], fileName: () => 'settings.js' },
          rollupOptions: { external: ['electron'] }
        }
      })
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: BUNDLED })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: BUNDLED }), settingsPreload()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          // the hidden picture-search window (src/main/picture-search/webgpu-embedder.ts)
          embedder: resolve(__dirname, 'src/preload/embedder.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          settings: resolve(__dirname, 'src/renderer/settings.html')
        }
      }
    },
    plugins: [react()]
  }
})
