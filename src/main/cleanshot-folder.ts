/**
 * CleanShot X's own export folder, read from its preferences at runtime (never guessed). The reader is
 * injectable so tests and callers can supply a fake. Returns null when the setting is missing or the
 * folder does not exist, in which case the CleanShot default is not offered.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type DefaultsReader = () => Promise<string | null>

/** `defaults read pl.maketheweb.cleanshotx exportPath` via execFile (no shell). */
export const readCleanShotExportPath: DefaultsReader = () =>
  new Promise((resolve) => {
    execFile('defaults', ['read', 'pl.maketheweb.cleanshotx', 'exportPath'], { timeout: 3000 }, (err, stdout) => resolve(err ? null : String(stdout).trim() || null))
  })

export function normaliseExportPath(raw: string | null): string | null {
  if (!raw) return null
  let p = raw.trim()
  if (p.startsWith('file://')) {
    try {
      p = decodeURIComponent(new URL(p).pathname)
    } catch {
      return null
    }
  }
  if (p === '~') p = homedir()
  else if (p.startsWith('~/')) p = join(homedir(), p.slice(2))
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}

export async function cleanShotFolder(read: DefaultsReader = readCleanShotExportPath, exists: (p: string) => boolean = existsSync): Promise<string | null> {
  const p = normaliseExportPath(await read().catch(() => null))
  return p && exists(p) ? p : null
}
