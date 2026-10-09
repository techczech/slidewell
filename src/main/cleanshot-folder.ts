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

// ---- Changing CleanShot's export folder (backlog import, ticket 13): only on the user's click. ----

/** Writes CleanShot's export path. Injectable: tests and previews pass a fake and never touch the real setting. */
export type DefaultsWriter = (path: string) => Promise<boolean>

/** Exact argv for `defaults` (no shell). */
export function exportPathWriteArgs(path: string): string[] {
  return ['write', 'pl.maketheweb.cleanshotx', 'exportPath', '-string', path]
}

/** The same command as the user would type it in Terminal; shown before the click. */
export function exportPathCommand(path: string): string {
  return `defaults ${exportPathWriteArgs(path)
    .map((a) => (/^[\w./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
    .join(' ')}`
}

export const writeCleanShotExportPath: DefaultsWriter = (path) =>
  new Promise((resolve) => {
    execFile('defaults', exportPathWriteArgs(path), { timeout: 3000 }, (err) => resolve(!err))
  })

export type CleanShotSetting = { current: string | null; target: string; command: string; matches: boolean }

export async function cleanShotSetting(target: string, read: DefaultsReader = readCleanShotExportPath): Promise<CleanShotSetting> {
  const current = normaliseExportPath(await read().catch(() => null))
  const t = normaliseExportPath(target) ?? target
  return { current, target: t, command: exportPathCommand(t), matches: current === t }
}

/** Point CleanShot at `target`, then read the setting back to confirm. */
export async function setCleanShotExportPath(
  target: string,
  write: DefaultsWriter = writeCleanShotExportPath,
  read: DefaultsReader = readCleanShotExportPath
): Promise<CleanShotSetting & { ok: boolean }> {
  const t = normaliseExportPath(target) ?? target
  const wrote = await write(t).catch(() => false)
  const after = await cleanShotSetting(t, read)
  return { ...after, ok: wrote && after.matches }
}
