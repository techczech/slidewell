import { defineConfig } from 'vitest/config'

// Unit tests live in test/ and exercise pure main-process modules (no Electron).
// Kept separate from electron.vite.config.ts so vitest never loads the Electron build config.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The HTTP finder serves this raw asset to Chromium. Keep Vitest's CSS stub off it.
    css: { include: [/air-finder\/finder\.css\?raw$/] }
  }
})
