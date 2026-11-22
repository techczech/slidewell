/**
 * The Triage source walker: every file under a capture folder (or the top level only), skipping
 * hidden entries, tool folders, and the `Moved by SlideWell <date>` folders the backlog import fills
 * with Desktop originals (their copies already sit at the top of the watched folder).
 * `exclude` (canonical) is a subtree never entered, decided on each folder's realpath: another
 * source's scan never walks into the primary Triage folder nested inside it (ticket 15).
 */
import { readdirSync, realpathSync, type Dirent } from 'node:fs'
import { opendir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { isMovedFolderName } from './backlog-plan'

const SKIP_DIRS = new Set(['.git', 'node_modules', '.Trash', '$RECYCLE.BIN'])
const ignored = (name: string): boolean => name.startsWith('.') || SKIP_DIRS.has(name)
const within = (dir: string, root: string): boolean => dir === root || dir.startsWith(`${root}/`)

const excluded = (dir: string, exclude: string): boolean => {
  let r: string
  try {
    r = realpathSync.native(dir)
  } catch {
    return true // a folder that cannot be resolved is not entered
  }
  return within(r, exclude)
}

export function* walk(dir: string, recursive = true, exclude: string | null = null): Generator<{ abs: string }> {
  if (exclude && excluded(dir, exclude)) return
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (ignored(e.name)) continue
    const abs = join(dir, e.name)
    if (e.isDirectory()) {
      if (recursive && !isMovedFolderName(e.name)) yield* walk(abs, recursive, exclude)
    } else if (e.isFile()) {
      yield { abs }
    }
  }
}

/** The same capture listing for background scans, yielding to Electron during directory I/O. */
export async function* walkAsync(dir: string, recursive = true, exclude: string | null = null): AsyncGenerator<{ abs: string }> {
  if (exclude && within(await realpath(dir), exclude)) return
  const subdirs: string[] = []
  for await (const entry of await opendir(dir)) {
    if (ignored(entry.name)) continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (recursive && !isMovedFolderName(entry.name)) subdirs.push(abs)
    } else if (entry.isFile()) {
      yield { abs }
    }
  }
  for (const subdir of subdirs) {
    try {
      yield* walkAsync(subdir, recursive, exclude)
    } catch {
      // A child that disappeared or became unreadable cannot supply captures.
    }
  }
}
