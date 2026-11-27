import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import { slideWellConfig } from '../../electron.vite.config'

const main = slideWellConfig('out').main!
export default defineConfig({
  main: {
    ...main,
    build: {
      ...main.build,
      rollupOptions: {
        ...main.build?.rollupOptions,
        input: { catalogue: resolve('src/main/air-finder/catalogue-client.ts') },
        preserveEntrySignatures: 'strict'
      }
    }
  }
})
