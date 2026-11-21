import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CONFIG_UNREADABLE, patchConfigFile, readConfigFile } from '../src/main/config-file'
import { migrateFromConfig } from '../src/main/settings-migration'

vi.mock('node:fs', async (loadOriginal) => {
  const fs = await loadOriginal<typeof import('node:fs')>()
  return { ...fs, renameSync: vi.fn(fs.renameSync) }
})

let dir: string
let config: string
beforeEach(() => {
  mkdirSync('out', { recursive: true })
  dir = mkdtempSync(join(process.cwd(), 'out', 'config-file-test-'))
  config = join(dir, 'config.json')
})
afterEach(() => {
  vi.mocked(renameSync).mockRestore()
  rmSync(dir, { recursive: true, force: true })
})

it('stops migration when the existing config is damaged and keeps one recovery copy', async () => {
  const damaged = Buffer.from('{"windowBounds":')
  writeFileSync(config, damaged)

  const log = vi.fn()
  expect((await migrateFromConfig(dir, '0.4.0', log)).kind).toBe('failed')
  expect((await migrateFromConfig(dir, '0.4.0', log)).kind).toBe('failed')
  const makeNext = vi.fn(() => ({ windowBounds: { width: 800, height: 600 } }))
  expect(() => patchConfigFile(dir, makeNext, log)).toThrow(CONFIG_UNREADABLE)
  expect(makeNext).not.toHaveBeenCalled()
  expect(log).toHaveBeenCalledTimes(1)

  const copies = readdirSync(dir).filter((name) => name.startsWith('config.json.unreadable-'))
  expect(copies).toHaveLength(1)
  expect(readFileSync(join(dir, copies[0])).equals(damaged)).toBe(true)
  expect(readFileSync(config).equals(damaged)).toBe(true)
  expect(readdirSync(dir).sort()).toEqual(['config.json', copies[0]].sort())
})

it('keeps the active bytes intact and removes staged files if the final rename fails', async () => {
  const initial = Buffer.from('{"archiveRoot":"/synthetic"}\n')
  writeFileSync(config, initial)
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(renameSync).mockImplementation((from, to) => {
    if (to === config) throw new Error('synthetic rename failure')
    fs.renameSync(from, to)
  })

  expect(() => patchConfigFile(dir, (current) => ({ ...current, windowBounds: { width: 800, height: 600 } })))
    .toThrow('synthetic rename failure')
  expect(readFileSync(config).equals(initial)).toBe(true)
  expect(readFileSync(`${config}.previous`).equals(initial)).toBe(true)
  expect(readdirSync(dir).sort()).toEqual(['config.json', 'config.json.previous'])
})

it('patches valid state without dropping unmodified fields and rotates the previous copy', () => {
  const initial = {
    r2: { accessKeyIdEnc: 'synthetic-r2-field-a', secretEnc: 'synthetic-r2-field-b' },
    sorterCloud: { optedInAt: '2026-01-01T00:00:00Z' },
    archiveRoot: '/synthetic'
  }
  const bytes = Buffer.from(JSON.stringify(initial) + '\n')
  writeFileSync(config, bytes)

  patchConfigFile(dir, (current) => ({ ...current, windowBounds: { width: 1200, height: 900 } }))
  const firstSave = readFileSync(config)
  expect(readFileSync(`${config}.previous`).equals(bytes)).toBe(true)
  patchConfigFile(dir, (current) => ({ ...current, windowBounds: { width: 800, height: 600 } }))

  const saved = readConfigFile<typeof initial & { windowBounds: { width: number; height: number } }>(dir)
  expect(saved?.windowBounds).toEqual({ width: 800, height: 600 })
  expect(saved?.archiveRoot === initial.archiveRoot).toBe(true)
  expect(JSON.stringify(saved?.r2) === JSON.stringify(initial.r2)).toBe(true)
  expect(JSON.stringify(saved?.sorterCloud) === JSON.stringify(initial.sorterCloud)).toBe(true)
  expect(readFileSync(`${config}.previous`).equals(firstSave)).toBe(true)
  expect(readdirSync(dir).sort()).toEqual(['config.json', 'config.json.previous'])
})

it('refuses an unreadable file even when a recovery copy cannot be made', () => {
  mkdirSync(config)
  const log = vi.fn()
  expect(() => readConfigFile(dir, log)).toThrow(CONFIG_UNREADABLE)
  expect(() => patchConfigFile(dir, () => ({}), log)).toThrow(CONFIG_UNREADABLE)
  expect(log).toHaveBeenCalledTimes(1)
  expect(readdirSync(dir)).toEqual(['config.json'])
})
