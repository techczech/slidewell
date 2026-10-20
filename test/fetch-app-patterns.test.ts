import { afterEach, expect, test } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { collectTarballs, fetchAppPatterns, verifyIntegrity } from '../scripts/fetch-app-patterns.mjs'

const fixture = Buffer.from('local tarball fixture\n')
const integrity = 'sha512-' + createHash('sha512').update(fixture).digest('base64')
const spec = 'file:./vendor/app-patterns/app-patterns-settings-electron-0.3.0.tgz'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'slidewell-fetch-test-'))
  roots.push(root)
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { '@app-patterns/settings-electron': spec } }))
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ packages: {
    'node_modules/@app-patterns/settings-electron': { integrity }
  } }))
  return root
}

test('collects and deduplicates tarballs from dependencies, devDependencies and nested overrides', () => {
  expect(collectTarballs({ dependencies: { a: spec }, devDependencies: { b: spec }, overrides: { parent: { c: spec } } }))
    .toEqual([{ name: 'app-patterns-settings-electron-0.3.0.tgz', pkg: '@app-patterns/settings-electron', version: '0.3.0' }])
  expect(collectTarballs({ dependencies: { other: '^1.0.0' } })).toEqual([])
  expect(() => collectTarballs({ overrides: { bad: 'file:./vendor/app-patterns/../bad.tgz' } })).toThrow(/Invalid/)
})

test('verifies local fixture integrity and refuses changed bytes or missing sha512', () => {
  expect(() => verifyIntegrity(fixture, integrity, 'fixture')).not.toThrow()
  expect(() => verifyIntegrity(Buffer.from('corrupt'), integrity, 'fixture')).toThrow(/Integrity mismatch.*fixture/)
  expect(() => verifyIntegrity(fixture, undefined, 'fixture')).toThrow(/sha512/)
})

test('verifies existing files without downloading and refuses corrupt existing files', async () => {
  const root = await project()
  const dir = join(root, 'vendor/app-patterns')
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'app-patterns-settings-electron-0.3.0.tgz')
  await writeFile(path, fixture)
  const noNetwork = async () => { throw new Error('unexpected network') }
  await fetchAppPatterns(root, noNetwork)
  await writeFile(path, 'corrupt')
  await expect(fetchAppPatterns(root, noNetwork)).rejects.toThrow(/Integrity mismatch/)
})

test('downloads, verifies and renames a missing tarball', async () => {
  const root = await project()
  await fetchAppPatterns(root, async (url: string) => {
    expect(url).toBe('https://github.com/techczech/app-patterns/releases/download/v0.3.0/app-patterns-settings-electron-0.3.0.tgz')
    return new Response(fixture)
  })
  const dir = join(root, 'vendor/app-patterns')
  expect(await readdir(dir)).toEqual(['app-patterns-settings-electron-0.3.0.tgz'])
  expect(await readFile(join(dir, 'app-patterns-settings-electron-0.3.0.tgz'))).toEqual(fixture)
})

test('cleans temporary files on integrity and HTTP failures', async () => {
  const root = await project()
  await expect(fetchAppPatterns(root, async () => new Response('corrupt'))).rejects.toThrow(/Integrity mismatch/)
  expect(await readdir(join(root, 'vendor/app-patterns'))).toEqual([])
  await expect(fetchAppPatterns(root, async () => new Response('', { status: 404, statusText: 'Not Found' })))
    .rejects.toThrow(/HTTP 404 Not Found.*github.com/)
  expect(await readdir(join(root, 'vendor/app-patterns'))).toEqual([])
})
