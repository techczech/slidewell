// Only the separate update-test Vite configuration defines this to true.
import { app } from 'electron'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

declare const __SLIDEWELL_UPDATE_FIXTURE__: boolean
export const isUpdateFixture = typeof __SLIDEWELL_UPDATE_FIXTURE__ !== 'undefined' && __SLIDEWELL_UPDATE_FIXTURE__

export function updateFixtureRoot(): string | null {
  if (!isUpdateFixture || !app.isPackaged) return null
  const bundle = resolve(process.execPath, '..', '..', '..')
  const root = dirname(bundle)
  if (!/^\/(?:private\/)?tmp\/swup-[A-Za-z0-9]+$/.test(root) ||
      !existsSync(join(root, 'fixture-marker')) || realpathSync(bundle) !== join(realpathSync(root), 'SlideWell Update Test.app')) return null
  return root
}

export function readFixtureFeed(root: string): string {
  return readFileSync(join(root, 'fixture-feed.txt'), 'utf8').trim()
}
