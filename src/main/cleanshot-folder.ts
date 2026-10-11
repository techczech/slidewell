/**
 * CleanShot X's own export folder, read from its preferences at runtime (never guessed). The reader is
 * injectable so tests and callers can supply a fake. Returns null when the setting is missing or the
 * folder does not exist, in which case the CleanShot default is not offered.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { compileNameTemplate, type NameTemplate } from './screenshot-name'

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

// ---- CleanShot's file name template (ticket 15): read-only, injectable like the export folder. ----

/** `defaults read pl.maketheweb.cleanshotx mediaNameTemplate` via execFile (no shell). */
export const readCleanShotNameTemplate: DefaultsReader = () =>
  new Promise((resolve) => {
    execFile('defaults', ['read', 'pl.maketheweb.cleanshotx', 'mediaNameTemplate'], { timeout: 3000 }, (err, stdout) => resolve(err ? null : String(stdout).trim() || null))
  })

/**
 * Parse the old-style property-list array `defaults read` prints, e.g. `( "CleanShot ", "%y", "-" )`.
 * Strings are quoted (escapes \\ \" \n \t \Uxxxx and octal) or bare words. Null for anything else.
 */
export function parseDefaultsArray(raw: string | null): string[] | null {
  if (!raw) return null
  const s = raw.trim()
  if (!s.startsWith('(') || !s.endsWith(')')) return null
  const out: string[] = []
  let i = 1
  const end = s.length - 1
  const skipWs = (): void => {
    while (i < end && /\s/.test(s[i])) i++
  }
  while (true) {
    skipWs()
    if (i >= end) break
    if (s[i] === '"') {
      i++
      let v = ''
      while (i < end && s[i] !== '"') {
        if (s[i] !== '\\') {
          v += s[i++]
          continue
        }
        const c = s[i + 1]
        if (c === 'U' && /^[0-9A-Fa-f]{4}$/.test(s.slice(i + 2, i + 6))) {
          v += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16))
          i += 6
        } else if (/[0-7]/.test(c ?? '') && /^[0-7]{3}$/.test(s.slice(i + 1, i + 4))) {
          v += String.fromCharCode(parseInt(s.slice(i + 1, i + 4), 8))
          i += 4
        } else {
          v += c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : (c ?? '')
          i += 2
        }
      }
      if (s[i] !== '"') return null // unterminated
      i++
      out.push(v)
    } else {
      const m = /^[A-Za-z0-9_$+\/:.%-]+/.exec(s.slice(i, end))
      if (!m) return null
      out.push(m[0])
      i += m[0].length
    }
    skipWs()
    if (i >= end) break
    if (s[i] !== ',') return null
    i++
  }
  return out
}

/** CleanShot's name template, compiled; null when unset, unreadable or without a full date. */
export async function cleanShotNameTemplate(read: DefaultsReader = readCleanShotNameTemplate): Promise<NameTemplate | null> {
  return compileNameTemplate(parseDefaultsArray(await read().catch(() => null)))
}
