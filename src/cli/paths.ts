import { homedir } from 'node:os'
import { join } from 'node:path'
import { APP_NAME } from '../shared/settings-schema'

/**
 * The folder Electron calls `userData` (named after productName), worked out without Electron so the
 * settings CLI finds the same settings.json as the app. SLIDEWELL_DATA_DIR overrides it (the app honours it too).
 */
export function userDataDir(env: Record<string, string | undefined> = process.env, platform: string = process.platform): string {
  const override = env['SLIDEWELL_DATA_DIR']
  if (override) return override
  if (platform === 'darwin') return join(env['HOME'] || homedir(), 'Library', 'Application Support', APP_NAME)
  if (platform === 'win32') return join(env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'), APP_NAME)
  return join(env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), APP_NAME)
}
