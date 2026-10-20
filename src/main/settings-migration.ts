// Moving SlideWell's preferences from userData/config.json (the old version's file) to the shared settings
// file userData/settings.json (a new file name). config.json is never copied, deleted or rewritten here: it
// stays the old version's file, and is the backup. It is read for migration only, and only for preferences
// the schema knows (prefsFromLegacy); the key ciphertext and anything else is never taken.
//
//   First launch (no settings.json): the preferences are handed to the store as settings.json
//   (`{ [LEGACY_MARK]: 1, prefs }`, by temporary file and link, so an existing file is never replaced); the
//   store's migrate hook reads them and writes the v2 file, each change logged as "app update".
//   Later launches: the stamp (settings-migration.json) records the preferences that were migrated and when.
//   If config.json's preferences differ from it (an older SlideWell changed them after a downgrade), each
//   preference that changed there is applied again, before the store opens for the app, unless the new
//   version changed that setting since the stamp (by you, an agent, an import or a reset): then the new
//   value is kept. A preference whose write did not land (the file locked or unwritable) is not stamped, so
//   the next launch tries it again; one the store refuses as invalid is stamped and stays as it is.
// No Electron here: `dir` is the user-data folder, so tests and the CLI run it on any folder.
import { existsSync, linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { commandsAdapter, type ChangeEntry } from '@app-patterns/settings'
import { SettingsStore, type LockOptions } from '@app-patterns/settings/node'
import { registry } from '../shared/commands'
import { APP_ID, LEGACY_MARK, migrateLegacy, prefsFromLegacy, schema } from '../shared/settings-schema'
import { foldersOverlap, libraryFolderRule, libraryRoots, OTHERS_DEFAULT, OVERLAP_REASON } from './settings-rules'

export const CONFIG_FILE = 'config.json'
export const SETTINGS_FILE = 'settings.json'
export const STAMP_FILE = 'settings-migration.json'
/** Who a re-migration is logged as: the store's actors are only you or an agent (package follow-up). */
export const REMIGRATION_AGENT = 'SlideWell update (settings from an older version)'

export type Migration =
  | { kind: 'none' }
  | { kind: 'first'; legacy: Record<string, unknown>; at: number }
  | {
      kind: 'again'
      legacy: Record<string, unknown>
      /** Keys whose value in config.json differs from the stamp. */
      changed: string[]
      /** Written to settings.json. */
      applied: string[]
      /** Changed in the new version since the stamp: the new value was kept. */
      kept: string[]
      /** Refused by the store as invalid: left as it is (stamped, not tried again). */
      refused: string[]
      /** Not written (the file locked or unwritable): not stamped, so the next launch tries again. */
      failed: string[]
      /** What the stamp records: config.json's preferences, except a failed key keeps its earlier stamped value. */
      stamp: Record<string, unknown>
      at: number
    }
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
export async function migrateFromConfig(
  dir: string,
  version: string,
  log: (line: string) => void = () => {},
  opts: { lock?: LockOptions; now?: () => number } = {}
): Promise<Migration> {
  const at = (opts.now ?? Date.now)()
  const legacy = readLegacyPrefs(dir)
  if (!existsSync(join(dir, SETTINGS_FILE))) {
    if (!legacy) return { kind: 'none' }
    // The store writes this hand-over itself (its migration), which libraryFolderRule lets through (settings-rules.ts),
    // so the library-folder rule is applied here: an Others' Library that overlaps the archive is left out
    // (it stays the default). The stamp still records it, so it is not tried again every launch.
    // The default can itself overlap the archive (an archive at ~/SlideWell/others-library), so the pair is
    // checked again after the fallback. The schema has no "no Others' Library" value: empty (the default) is
    // the only one, so it stays empty, the reason is logged, and the use-time check in index.ts refuses every
    // Others' import until a separate folder is picked.
    const handed = { ...legacy }
    if ('library.othersRoot' in handed) {
      const roots = libraryRoots(handed)
      if (foldersOverlap(roots.archive, roots.others)) {
        delete handed['library.othersRoot']
        log(`[settings] library.othersRoot from the older version was not applied: ${OVERLAP_REASON}`)
      }
    }
    const fallback = libraryRoots(handed)
    if (foldersOverlap(fallback.archive, fallback.others)) {
      delete handed['library.othersRoot']
      log(`[settings] library.othersRoot is left empty: its default folder (${OTHERS_DEFAULT}) overlaps your archive too, so imports into the Others’ Library are refused until a separate folder is picked in Settings.`)
    }
    try {
      writeVia(join(dir, SETTINGS_FILE), JSON.stringify({ [LEGACY_MARK]: 1, prefs: handed }, null, 2), true)
    } catch (e) {
      if (code(e) === 'EEXIST') return { kind: 'none' }
      return { kind: 'failed', reason: `settings.json could not be written (${code(e)})` }
    }
    return { kind: 'first', legacy, at }
  }
  const stamp = readStamp(dir)
  if (!legacy || !stamp) return { kind: 'none' }
  const changed = changedSince(stamp, legacy)
  if (changed.length === 0) return { kind: 'none' }
  const store = new SettingsStore({
    dir, app: APP_ID, schema, registry: commandsAdapter(registry), appVersion: version, migrate: migrateLegacy, beforeWrite: libraryFolderRule,
    who: { kind: 'agent', name: REMIGRATION_AGENT }, watch: false, log, ...(opts.lock ? { lock: opts.lock } : {})
  })
  const applied: string[] = []
  const kept: string[] = []
  const refused: string[] = []
  const failed: string[] = []
  try {
    await store.ready
    // Accepted residual: this snapshot is taken once, outside the write locks of the sets below, so a CLI
    // write to the same key landing between it and the re-migration write is overwritten. Same user on the
    // same Mac, at startup only; outside the threat model (review round 2, #1).
    const since = changedInStoreSince(store.view().changes, stamp.at)
    for (const key of changed) {
      if (failed.length > 0) {
        failed.push(key) // the file cannot be written now: the rest wait for the next launch too
        continue
      }
      if (since.has(key)) {
        kept.push(key)
        continue
      }
      const value = key in legacy ? legacy[key] : schema.def(key)?.default
      const r = await store.set(key, value)
      if (r.ok) applied.push(key)
      // Accepted residual: a value the store refuses as invalid is stamped on purpose (it never lands, so
      // retrying it every launch would only repeat the refusal and its log line; review round 2, #2).
      else if (OP_REFUSALS.has(r.code)) {
        refused.push(key)
        log(`[settings] ${key} from the older version was not applied: ${r.error}`)
      } else {
        failed.push(key)
        log(`[settings] ${key} from the older version was not applied yet (${r.error}); it is tried again next launch`)
      }
    }
  } finally {
    await store.close()
  }
  const next: Record<string, unknown> = { ...legacy }
  for (const key of failed) {
    if (key in stamp.legacy) next[key] = stamp.legacy[key]
    else delete next[key]
  }
  // A key still owed keeps the earlier stamp's time, so a change the new version made to it before this launch still wins next time.
  return { kind: 'again', legacy, changed, applied, kept, refused, failed, stamp: next, at: failed.length > 0 ? stamp.at : at }
}

/** The store refused the value itself (not the file): trying again would give the same answer. */
const OP_REFUSALS: ReadonlySet<string> = new Set(['unknown-key', 'secret', 'invalid-value', 'rejected', 'not-possible', 'too-many', 'already', 'not-found'])

/**
 * Settings changed in the new version after `at`: by you, an agent other than the re-migration, an import or a
 * reset. The loader's own entries (app update: the first migration, repairs) are not a change by anyone.
 */
function changedInStoreSince(changes: readonly ChangeEntry[], at: number): Set<string> {
  const out = new Set<string>()
  for (const e of changes) {
    if (e.at < at) continue
    if (e.who.kind === 'app-update') continue
    if (e.who.kind === 'agent' && e.who.name === REMIGRATION_AGENT) continue
    const rec = e as unknown as { key?: unknown; targets?: unknown }
    if (typeof rec.key === 'string') out.add(rec.key)
    if (Array.isArray(rec.targets)) for (const t of rec.targets) if (typeof t === 'string') out.add(t)
  }
  return out
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
  // `at` is when the migration ran, so a change made after it (by the CLI in the same run) counts as the new version's.
  const legacy = m.kind === 'again' ? m.stamp : m.kind === 'first' ? m.legacy : readLegacyPrefs(dir) ?? {}
  const at = m.kind === 'again' || m.kind === 'first' ? m.at : now()
  const stamp: Stamp = { format: 'slidewell-settings-migration', at, version, legacy }
  writeVia(join(dir, STAMP_FILE), JSON.stringify(stamp, null, 2), false)
  return true
}
