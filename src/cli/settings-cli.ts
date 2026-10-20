// `slidewell settings <list|get|set|reset|changes|export|import|undo-import> [--json]`
// The agent path to the same settings file and changelog the Settings window uses (changes are logged
// as made by an agent). Run with bun (`bin/slidewell.mjs`, `npm run settings -- list`); needs no Electron.
// Keys are never read or printed here: a key shows only as kept in the keychain.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { commandsAdapter } from '@bridle/settings'
import { runSettingsCli, type LockOptions, type SettingsCliIO } from '@bridle/settings/node'
import { registry } from '../shared/commands'
import { APP_ID, APP_NAME, migrateLegacy, schema } from '../shared/settings-schema'
import { migrateFromConfig, stampMigration } from '../main/settings-migration'
import { libraryFolderRule } from '../main/settings-rules'
import { userDataDir } from './paths'

export function appVersion(): string {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8')) as { version: string }
  return pkg.version
}

const processIO = { stdout: (t: string): void => void process.stdout.write(t), stderr: (t: string): void => void process.stderr.write(t) }

/** `dir`, `io` and `lock` (how long to wait for the settings file) are injectable for tests; by default the real userData folder and the terminal. */
export async function run(argv: string[], io: SettingsCliIO = processIO, dir: string = userDataDir(), lock?: LockOptions): Promise<number> {
  // Run before the app has started this version: move config.json's preferences first, exactly as the app
  // would, so the CLI never creates an empty settings.json that would hide them.
  const version = appVersion()
  const migration = await migrateFromConfig(dir, version, () => {}, lock ? { lock } : {})
  if (migration.kind === 'failed') {
    io.stderr(`SlideWell could not move its settings to the new settings file (${migration.reason}). Nothing was changed.\n`)
    return 1
  }
  if (migration.kind === 'again' && migration.failed.length > 0) {
    io.stderr(`${migration.failed.length} setting(s) changed in an older SlideWell could not be applied yet; they are tried again next time.\n`)
  }
  const code = await runSettingsCli(
    argv,
    { app: APP_ID, appName: APP_NAME, dir, schema, registry: commandsAdapter(registry), version, migrate: migrateLegacy, beforeWrite: libraryFolderRule, ...(lock ? { lock } : {}) },
    io
  )
  try {
    stampMigration(dir, version, migration) // only once settings.json is in the new format
  } catch {
    /* the app stamps it on its next launch */
  }
  return code
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)))
