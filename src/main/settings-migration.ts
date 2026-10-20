// Moving SlideWell's preferences from userData/config.json (the old version's file) to the shared settings
// file userData/settings.json (a new file name). config.json is never copied, deleted or rewritten here: it
// stays the old version's file, and is the backup. It is read for migration only, and only for preferences
// the schema knows (prefsFromLegacy); the key ciphertext and anything else is never taken.
//
//   First launch (no settings.json): the preferences are handed to the store as settings.json
//   (`{ [LEGACY_MARK]: 1, prefs }`, by temporary file and link, so an existing file is never replaced); the
//   store's migrate hook reads them and writes the v2 file, each change logged as "app update".
//   Later launches: the stamp (settings-migration.json) records the preferences that were migrated. If
//   config.json's preferences differ from it (an older SlideWell changed them after a downgrade), each
//   preference that changed there is applied again, before the store opens for the app.
// No Electron here: `dir` is the user-data folder, so tests and the CLI run it on any folder.
import { existsSync, linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { commandsAdapter } from '@bridle/settings'
import { SettingsStore } from '@bridle/settings/node'
import { registry } from '../shared/commands'
import { APP_ID, LEGACY_MARK, migrateLegacy, prefsFromLegacy, schema } from '../shared/settings-schema'

export const CONFIG_FILE = 'config.json'
export const SETTINGS_FILE = 'settings.json'
export const STAMP_FILE = 'settings-migration.json'
/** Who a re-migration is logged as: the store's actors are only you or an agent (package follow-up). */
export const REMIGRATION_AGENT = 'SlideWell update (settings from an older version)'

export type Migration =
  | { kind: 'none' }
  | { kind: 'first'; legacy: Record<string, unknown> }
  | { kind: 'again'; legacy: Record<string, unknown>; changed: string[] }
  | { kind: 'failed'; reason: string } // nothing was written; main keeps reading config.json as before

type Stamp = { format: 'slidewell-settings-migration'; at: number; version: string; legacy: Record<string, unknown> }

const isRec = (x: unknown): x is Record<string, unknown> => Boolean(x) && typeof x === 'object' && !Array.isArray(x)
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const code = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? 'error'

/** config.json's preferences by schema key, or null when there is no readable config.json. No size cap: it is the old version's own file. */
export function readLegacyPrefs(dir: string): Record<string, unknown> | null {
  try {
    const cfg: unknown = JSON.parse(readFileSync(join(dir, CONFIG_FILE), 'utf8'))
    return isRec(cfg) ? prefsFromLegacy(cfg) : null
  } catch {
    return null
  }
}

function readStamp(dir: string): Stamp | null {
  try {
    const s: unknown = JSON.parse(readFileSync(join(dir, STAMP_FILE), 'utf8'))
    return isRec(s) && s['format'] === 'slidewell-settings-migration' && isRec(s['legacy']) ? (s as Stamp) : null
  } catch {
    return null
  }
}

/** Writes through a temporary file in the same folder; `exclusive` never replaces an existing file. */
function writeVia(path: string, text: string, exclusive: boolean): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.migrate.tmp`
  writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' })
  try {
    if (exclusive) linkSync(tmp, path)
    else renameSync(tmp, path)
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp)
  }
}

/** Keys whose value in config.json now differs from the stamp. */
function changedSince(stamp: Stamp, legacy: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(stamp.legacy), ...Object.keys(legacy)])
  return [...keys].filter((k) => schema.def(k) && schema.def(k)?.type !== 'secret' && !same(stamp.legacy[k], legacy[k]))
}

/**
 * Runs before the store opens for the app (or the CLI), so startup reads one settings snapshot. Hands a
 * first migration to the store, or applies a re-migration through a short-lived store.
 */
export async function migrateFromConfig(dir: string, version: string, log: (line: string) => void = () => {}): Promise<Migration> {
  const legacy = readLegacyPrefs(dir)
  if (!existsSync(join(dir, SETTINGS_FILE))) {
    if (!legacy) return { kind: 'none' }
    try {
      writeVia(join(dir, SETTINGS_FILE), JSON.stringify({ [LEGACY_MARK]: 1, prefs: legacy }, null, 2), true)
    } catch (e) {
      if (code(e) === 'EEXIST') return { kind: 'none' }
      return { kind: 'failed', reason: `settings.json could not be written (${code(e)})` }
    }
    return { kind: 'first', legacy }
  }
  const stamp = readStamp(dir)
  if (!legacy || !stamp) return { kind: 'none' }
  const changed = changedSince(stamp, legacy)
  if (changed.length === 0) return { kind: 'none' }
  const store = new SettingsStore({
    dir, app: APP_ID, schema, registry: commandsAdapter(registry), appVersion: version, migrate: migrateLegacy,
    who: { kind: 'agent', name: REMIGRATION_AGENT }, watch: false, log
  })
  try {
    await store.ready
    for (const key of changed) {
      const value = key in legacy ? legacy[key] : schema.def(key)?.default
      const r = await store.set(key, value)
      if (!r.ok) log(`[settings] ${key} from the older version was not applied: ${r.error}`)
    }
  } finally {
    await store.close()
  }
  return { kind: 'again', legacy, changed }
}

/**
 * After the store is ready: records which preferences of config.json the settings file now reflects. Only
 * once settings.json is in the new format (a read-only CLI command may leave the hand-over copy for the app).
 */
export function stampMigration(dir: string, version: string, m: Migration, now: () => number = Date.now): boolean {
  if (m.kind === 'none' || m.kind === 'failed') {
    if (m.kind === 'failed' || readStamp(dir)) return false
  }
  try {
    const saved: unknown = JSON.parse(readFileSync(join(dir, SETTINGS_FILE), 'utf8'))
    if (!isRec(saved) || saved['format'] !== 'bridle-settings') return false
  } catch {
    return false
  }
  const legacy = m.kind === 'first' || m.kind === 'again' ? m.legacy : readLegacyPrefs(dir) ?? {}
  const stamp: Stamp = { format: 'slidewell-settings-migration', at: now(), version, legacy }
  writeVia(join(dir, STAMP_FILE), JSON.stringify(stamp, null, 2), false)
  return true
}
