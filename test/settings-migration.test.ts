// Preferences move from config.json (the old version's file, never rewritten, copied or deleted) to the new
// settings.json through the real store, on a temporary user-data folder. The legacy fixture carries fake keys:
// none may appear in any file the migration writes.
import { afterEach, describe, expect, test } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandsAdapter } from '@bridle/settings'
import { SettingsStore } from '@bridle/settings/node'
import { registry } from '../src/shared/commands'
import { APP_ID, migrateLegacy, schema } from '../src/shared/settings-schema'
import { migrateFromConfig, REMIGRATION_AGENT, stampMigration, STAMP_FILE } from '../src/main/settings-migration'
import { run } from '../src/cli/settings-cli'

const VERSION = '0.4.0-alpha.16'
const FAKE_SECRETS = ['FAKE-R2-ACCESS-1111', 'FAKE-R2-SECRET-2222', 'FAKE-OPENAI-3333', 'FAKE-ANTHROPIC-4444', 'FAKE-PLAIN-5555']
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const OLD = {
  archiveRoot: '/tmp/fake-archive',
  wellRoot: '/tmp/fake-well',
  convertOcrByDefault: true,
  ownerNames: ['Jane Smith', 'jsmith'],
  sorterPeriod: '30d',
  sorterAutoRetrain: false,
  reviewLeaveOutNotOnMac: true,
  pictureSearch: { includeWell: false, paused: true },
  r2: { accountId: 'acc123', bucket: 'ppt-archive-media', prefix: 'mine', accessKeyIdEnc: FAKE_SECRETS[0], secretEnc: FAKE_SECRETS[1], secretAccessKey: FAKE_SECRETS[4] },
  storage: { well: { backend: 'r2' } },
  sorterCloud: { provider: 'anthropic', keyEnc: FAKE_SECRETS[2], anthropicKeyEnc: FAKE_SECRETS[3], optedInAt: '2026-10-01T00:00:00Z' },
  apiKey: FAKE_SECRETS[4],
  windowBounds: { width: 1200, height: 800 },
  captureSources: [{ path: '/tmp/desk', namedOnly: true }]
}

function folder(config?: unknown): string {
  const d = mkdtempSync(join(tmpdir(), 'sw-settings-'))
  dirs.push(d)
  if (config !== undefined) writeFileSync(join(d, 'config.json'), JSON.stringify(config, null, 2))
  return d
}

/** What the app does at startup: migrate, open the store once, stamp. */
async function launch(dir: string, version = VERSION): Promise<SettingsStore> {
  const m = await migrateFromConfig(dir, version)
  const store = new SettingsStore({ dir, app: APP_ID, schema, registry: commandsAdapter(registry), appVersion: version, migrate: migrateLegacy, log: () => {} })
  await store.ready
  stampMigration(dir, version, m)
  return store
}

function writtenFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f !== 'config.json' && statSync(join(dir, f)).isFile()).map((f) => readFileSync(join(dir, f), 'utf8'))
}

describe('migration from config.json', () => {
  test('preferences move, each non-default one logged as an app update; config.json is left exactly as it was', async () => {
    const dir = folder(OLD)
    const before = readFileSync(join(dir, 'config.json'))
    const mtime = statSync(join(dir, 'config.json')).mtimeMs
    const store = await launch(dir)
    const v = store.view()
    expect(v.settings).toMatchObject({
      'library.archiveRoot': '/tmp/fake-archive', 'library.wellRoot': '/tmp/fake-well', 'library.convertOcr': true,
      'library.ownerNames': 'Jane Smith, jsmith', 'sorting.period': '30d', 'sorting.autoRetrain': false,
      'capture.leaveOutNotOnMac': true, 'library.includeWellInPictureSearch': false, 'storage.r2AccountId': 'acc123',
      'storage.r2Prefix': 'mine', 'storage.wellBackend': 'r2'
    })
    expect('storage.r2Bucket' in v.settings).toBe(false)
    expect(v.changes.map((e) => ('key' in e ? e.key : null))).not.toContain('storage.r2Bucket') // a default logs nothing
    expect(v.changes.length).toBe(11)
    for (const e of v.changes) expect(e.who).toEqual({ kind: 'app-update', version: VERSION })
    expect(readFileSync(join(dir, 'config.json')).equals(before)).toBe(true)
    expect(statSync(join(dir, 'config.json')).mtimeMs).toBe(mtime)
    expect(readdirSync(dir).filter((f) => f.includes('backup'))).toEqual([]) // no copy: config.json is the backup
    await store.close()
  })

  test('no fake key from the legacy file appears in any file written (settings, stamp, export)', async () => {
    const dir = folder(OLD)
    const store = await launch(dir)
    await store.close()
    const out: string[] = []
    expect(await run(['export', join(dir, 'export.json')], { stdout: (t) => void out.push(t), stderr: () => {} }, dir)).toBe(0)
    const files = writtenFiles(dir)
    expect(files.length).toBeGreaterThanOrEqual(3)
    for (const text of [...files, out.join('')]) for (const secret of FAKE_SECRETS) expect(text).not.toContain(secret)
  })

  test('the next launch migrates nothing and logs nothing new', async () => {
    const dir = folder(OLD)
    const first = await launch(dir)
    const count = first.view().changes.length
    await first.close()
    expect((await migrateFromConfig(dir, VERSION)).kind).toBe('none')
    const second = await launch(dir)
    expect(second.view().changes.length).toBe(count)
    await second.close()
  })

  test('downgrade, change in the old version, upgrade: the changed preferences are migrated again, the rest kept', async () => {
    const dir = folder(OLD)
    const first = await launch(dir)
    expect((await first.set('library.convertOcr', false)).ok).toBe(true) // a change made in the new version
    await first.close()
    // the older SlideWell writes config.json: a new archive folder and the well back to its default
    const { wellRoot: _w, ...rest } = OLD
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...rest, archiveRoot: '/tmp/moved-archive', windowBounds: { width: 900, height: 700 } }))
    const m = await migrateFromConfig(dir, VERSION)
    expect(m.kind).toBe('again')
    if (m.kind === 'again') expect(m.changed.sort()).toEqual(['library.archiveRoot', 'library.wellRoot'])
    const store = await launch(dir)
    const v = store.view()
    expect(v.settings['library.archiveRoot']).toBe('/tmp/moved-archive')
    expect('library.wellRoot' in v.settings).toBe(false)
    expect(v.settings['library.convertOcr'] ?? false).toBe(false) // untouched in the old version: the new value stays
    expect(v.changes.filter((e) => e.who.kind === 'agent' && e.who.name === REMIGRATION_AGENT).length).toBe(2)
    expect((await migrateFromConfig(dir, VERSION)).kind).toBe('none') // stamped again
    await store.close()
  })

  test('an invalid old value is reset with an entry, and the rest still moves', async () => {
    const dir = folder({ sorterPeriod: 'fortnight', archiveRoot: '/tmp/a' })
    const store = await launch(dir)
    expect(store.view().settings['library.archiveRoot']).toBe('/tmp/a')
    expect(store.view().settings['sorting.period']).toBeUndefined()
    expect(store.view().changes.some((e) => 'note' in e && e.note === 'INVALID_SAVED_VALUE')).toBe(true)
    await store.close()
  })

  test('only defaults and state: no entries; no config.json: nothing to migrate', async () => {
    const dir = folder({ windowBounds: { width: 1, height: 2 }, r2: { bucket: 'ppt-archive-media', prefix: 'slidewell' }, storage: { archive: { backend: 'local' } } })
    const store = await launch(dir)
    expect(store.view().changes).toEqual([])
    await store.close()
    expect((await migrateFromConfig(folder(), VERSION)).kind).toBe('none')
  })

  test('a large legacy file is read whole (no size cap)', async () => {
    const dir = folder({ ...OLD, captureSources: Array.from({ length: 20000 }, (_, i) => ({ path: `/tmp/p${i}`, namedOnly: false })) })
    expect(statSync(join(dir, 'config.json')).size).toBeGreaterThan(1024 * 1024)
    const store = await launch(dir)
    expect(store.view().settings['library.archiveRoot']).toBe('/tmp/fake-archive')
    await store.close()
  })

  test('the stamp holds only schema preferences', async () => {
    const dir = folder(OLD)
    const store = await launch(dir)
    await store.close()
    const stamp = JSON.parse(readFileSync(join(dir, STAMP_FILE), 'utf8'))
    for (const k of Object.keys(stamp.legacy)) expect(schema.def(k)?.type).not.toBe('secret')
    expect(Object.keys(stamp.legacy).every((k) => schema.def(k))).toBe(true)
  })

  const oldWrites = (dir: string, patch: Record<string, unknown>) => writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...OLD, ...patch }))
  const valueIn = async (dir: string, key: string) => {
    const store = await launch(dir)
    const v = store.view().settings[key]
    await store.close()
    return v
  }

  test('A, then B in the new version, then C in the old one, then upgrade: B is kept', async () => {
    const dir = folder(OLD) // A = /tmp/fake-archive
    const first = await launch(dir)
    expect((await first.set('library.archiveRoot', '/tmp/B')).ok).toBe(true)
    await first.close()
    oldWrites(dir, { archiveRoot: '/tmp/C', sorterPeriod: '7d' })
    const m = await migrateFromConfig(dir, VERSION)
    expect(m.kind).toBe('again')
    if (m.kind === 'again') {
      expect(m.kept).toEqual(['library.archiveRoot'])
      expect(m.applied).toEqual(['sorting.period']) // untouched in the new version: the old version's change applies
    }
    const store = await launch(dir)
    expect(store.view().settings['library.archiveRoot']).toBe('/tmp/B')
    expect(store.view().settings['sorting.period']).toBe('7d')
    await store.close()
    expect((await migrateFromConfig(dir, VERSION)).kind).toBe('none') // C is stamped: not tried again
  })

  test('A, then C in the old version only: C is applied', async () => {
    const dir = folder(OLD)
    await (await launch(dir)).close()
    oldWrites(dir, { archiveRoot: '/tmp/C' })
    expect(await valueIn(dir, 'library.archiveRoot')).toBe('/tmp/C')
  })

  /** A live lock on settings.json held by this process (never stale), as another writer would hold it. */
  const holdLock = (dir: string) => {
    const lock = join(dir, 'settings.json.lock')
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), nonce: 'held-by-test', host: hostname() }))
    return () => rmSync(lock, { force: true })
  }

  test('a re-migration write that does not land is not stamped, and is applied on the next launch', async () => {
    const dir = folder(OLD)
    await (await launch(dir)).close()
    oldWrites(dir, { archiveRoot: '/tmp/C' })
    const release = holdLock(dir)
    const m = await migrateFromConfig(dir, VERSION, () => {}, { lock: { waitMs: 200 } })
    release()
    expect(m.kind).toBe('again')
    if (m.kind === 'again') expect(m.failed).toEqual(['library.archiveRoot'])
    const store = new SettingsStore({ dir, app: APP_ID, schema, registry: commandsAdapter(registry), appVersion: VERSION, migrate: migrateLegacy, log: () => {} })
    await store.ready
    expect(store.view().settings['library.archiveRoot']).toBe('/tmp/fake-archive')
    stampMigration(dir, VERSION, m)
    await store.close()
    expect(JSON.parse(readFileSync(join(dir, STAMP_FILE), 'utf8')).legacy['library.archiveRoot']).toBe('/tmp/fake-archive') // still A
    const again = await migrateFromConfig(dir, VERSION)
    expect(again.kind).toBe('again') // tried again
    if (again.kind === 'again') expect(again.applied).toEqual(['library.archiveRoot'])
    expect(await valueIn(dir, 'library.archiveRoot')).toBe('/tmp/C')
  })

  test('the CLI path stamps only what landed too', async () => {
    const dir = folder(OLD)
    await (await launch(dir)).close()
    oldWrites(dir, { archiveRoot: '/tmp/C' })
    const release = holdLock(dir)
    const err: string[] = []
    await run(['list'], { stdout: () => {}, stderr: (t) => void err.push(t) }, dir, { waitMs: 200 })
    release()
    expect(err.join('')).toContain('tried again next time')
    expect(JSON.parse(readFileSync(join(dir, STAMP_FILE), 'utf8')).legacy['library.archiveRoot']).toBe('/tmp/fake-archive')
    const g: string[] = []
    expect(await run(['get', 'library.archiveRoot'], { stdout: (t) => void g.push(t), stderr: () => {} }, dir)).toBe(0)
    expect(g.join('').trim()).toBe('/tmp/C')
  })
})

describe('the library-folder rule on the first migration (the store writes it past the write rule)', () => {
  test('an older version’s identical archive and Others’ Library: the Others’ folder is left out, logged, and not retried', async () => {
    const dir = folder({ archiveRoot: '/tmp/fake-archive', othersArchiveRoot: '/tmp/fake-archive', convertOcrByDefault: true })
    const lines: string[] = []
    const m = await migrateFromConfig(dir, VERSION, (l) => void lines.push(l))
    expect(m.kind).toBe('first')
    const store = new SettingsStore({ dir, app: APP_ID, schema, registry: commandsAdapter(registry), appVersion: VERSION, migrate: migrateLegacy, log: () => {} })
    await store.ready
    stampMigration(dir, VERSION, m)
    expect(store.view().settings['library.archiveRoot']).toBe('/tmp/fake-archive')
    expect(store.view().settings['library.convertOcr']).toBe(true)
    expect('library.othersRoot' in store.view().settings).toBe(false)
    expect(lines.join('\n')).toContain('library.othersRoot')
    await store.close()
    expect((await migrateFromConfig(dir, VERSION)).kind).toBe('none') // stamped: not tried every launch
  })
})
