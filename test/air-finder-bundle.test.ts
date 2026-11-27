import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import type { createCatalogue } from '../src/main/air-finder/catalogue-client'
// @ts-expect-error Existing E2E fixture uses plain JavaScript.
import { makeFinderFixture, SHOWN_SLIDE, OTHER_SLIDE, SHOWN_WELL, OUT_OF_SCOPE_SLIDE } from '../e2e/support/finder-fixture.mjs'

test('the Electron Vite main build can launch its emitted catalogue worker and read a generated library', async () => {
  const root = await mkdtemp(join(tmpdir(), 'finder-bundle-'))
  const out = join(root, 'out')
  await promisify(execFile)(process.execPath, [
    resolve('node_modules/electron-vite/bin/electron-vite.js'), 'build',
    '--config', 'test/support/electron.vite.finder.config.ts', '--outDir', out
  ], { timeout: 25_000 })

  // Load the built client in Node so this test runs on the Studio without a GUI.
  // It starts the emitted worker through the real ?nodeWorker factory.
  const built: { createCatalogue: typeof createCatalogue } = createRequire(import.meta.url)(join(out, 'main/catalogue.js'))
  const { scope } = await makeFinderFixture(join(root, 'library'))
  const catalogue = await built.createCatalogue(scope)
  try {
    expect(await catalogue.generation()).toMatch(/^[a-f0-9]{64}$/)
    expect((await catalogue.words('lantern')).map((item) => item.itemId)).toEqual([
      SHOWN_SLIDE, OTHER_SLIDE, `well:${SHOWN_WELL}`
    ])
    await expect(catalogue.resolve(OUT_OF_SCOPE_SLIDE)).resolves.toBeNull()
  } finally {
    await catalogue.close()
  }
}, 30_000)
