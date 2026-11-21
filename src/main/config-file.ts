import { randomUUID } from 'node:crypto'
import { linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, type BigIntStats } from 'node:fs'
import { dirname, join } from 'node:path'

const CONFIG_FILE = 'config.json'
export const CONFIG_UNREADABLE = 'SlideWell could not read your saved state. Your config.json file has been left in place.'

export class ConfigReadError extends Error {
  readonly code = 'CONFIG_UNREADABLE'
  constructor() {
    super(CONFIG_UNREADABLE)
  }
}

type Snapshot<T> = { value: T; bytes: Buffer; stat: BigIntStats }
type Log = (message: string) => void
const reported = new Map<string, string>()
const utf8 = new TextDecoder('utf-8', { fatal: true })

function statOf(path: string): BigIntStats | undefined {
  return lstatSync(path, { bigint: true, throwIfNoEntry: false })
}

function revision(stat: BigIntStats | undefined): string {
  return stat ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') : ''
}

function withStagedFile(path: string, bytes: Buffer, publish: (tmp: string) => void): void {
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx', flush: true })
    publish(tmp)
  } finally {
    rmSync(tmp, { force: true })
  }
}

function preserveUnreadable(path: string, stat: BigIntStats | undefined, bytes: Buffer | undefined, log: Log): void {
  const id = revision(stat)
  if (reported.get(path) === id) return
  let copied = false
  if (stat && bytes) {
    const date = stat.mtime.toISOString().replace(/:/g, '-')
    const copy = `${path}.unreadable-${date}-${stat.ctimeNs}-${stat.ino}`
    try {
      if (statOf(copy)) {
        reported.set(path, id)
        return
      }
      withStagedFile(copy, bytes, (tmp) => linkSync(tmp, copy))
      copied = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        reported.set(path, id)
        return
      }
      // The original remains in place even when a recovery copy cannot be made.
    }
  }
  reported.set(path, id)
  log(`[config] ${CONFIG_UNREADABLE}${copied ? ' A dated recovery copy was saved beside it.' : ' A recovery copy could not be created.'}`)
}

function readSnapshot<T extends object>(path: string, log: Log): Snapshot<T> | undefined {
  let stat: BigIntStats | undefined
  let bytes: Buffer | undefined
  try {
    stat = statOf(path)
    if (!stat) return undefined
    if (!stat.isFile()) throw new ConfigReadError()
    const contents = readFileSync(path)
    if (revision(statOf(path)) !== revision(stat)) throw new ConfigReadError()
    bytes = contents
    const value: unknown = JSON.parse(utf8.decode(bytes))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigReadError()
    reported.delete(path)
    return { value: value as T, bytes, stat }
  } catch {
    preserveUnreadable(path, stat, bytes, log)
    throw new ConfigReadError()
  }
}

/** Returns undefined for a new profile. An existing unreadable file throws instead. */
export function readConfigFile<T extends object>(dir: string, log: Log = console.warn): T | undefined {
  return readSnapshot<T>(join(dir, CONFIG_FILE), log)?.value
}

/** All config writes read the current file first and retain its exact bytes as the previous good copy. */
export function patchConfigFile<T extends object>(dir: string, makeNext: (current: T | undefined) => T, log: Log = console.warn): void {
  const path = join(dir, CONFIG_FILE)
  const before = readSnapshot<T>(path, log)
  const bytes = Buffer.from(JSON.stringify(makeNext(before?.value), null, 2), 'utf8')
  if (before?.bytes.equals(bytes)) return
  mkdirSync(dirname(path), { recursive: true })
  withStagedFile(path, bytes, (tmp) => {
    const unchanged = () => {
      if (revision(statOf(path)) !== revision(before?.stat)) throw new Error('The saved state changed during the write.')
    }
    unchanged()
    if (before) {
      const backup = `${path}.previous`
      withStagedFile(backup, before.bytes, (stagedBackup) => renameSync(stagedBackup, backup))
    }
    unchanged()
    renameSync(tmp, path)
  })
}
