import { fileURLToPath } from 'node:url'
import { build, type Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

// Electron Vite handles this import in the desktop build. Bundle the same worker for Node tests.
function finderCatalogueWorker(): Plugin {
  const id = '\0slidewell-test-finder-worker'
  return {
    name: 'slidewell-test-finder-worker',
    enforce: 'pre',
    resolveId(source) {
      if (source === './catalogue-worker?nodeWorker') return id
    },
    async load(source) {
      if (source !== id) return
      const entry = fileURLToPath(new URL('./src/main/air-finder/catalogue-worker.ts', import.meta.url))
      const result = await build({
        configFile: false, logLevel: 'warn',
        build: {
          write: false, target: 'node22',
          lib: { entry, formats: ['cjs'] },
          rollupOptions: { external: [/^node:/] }
        }
      })
      const chunk = 'output' in result && result.output.find((entry) => entry.type === 'chunk')
      if (!chunk) throw new Error('Could not bundle the finder catalogue worker for tests')
      return `import { Worker } from 'node:worker_threads'
        export default (options) => new Worker(${JSON.stringify(chunk.code)}, { ...options, eval: true })`
    }
  }
}

// Unit tests live in test/ and exercise pure main-process modules (no Electron).
// Kept separate from electron.vite.config.ts so vitest never loads the Electron build config.
export default defineConfig({
  plugins: [finderCatalogueWorker()],
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The HTTP finder serves this raw asset to Chromium. Keep Vitest's CSS stub off it.
    css: { include: [/air-finder\/finder\.css\?raw$/] }
  }
})
