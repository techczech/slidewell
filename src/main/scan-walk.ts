/**
 * The Triage source walker: every file under a capture folder (or the top level only), skipping
 * hidden entries, tool folders, and the `Moved by SlideWell <date>` folders the backlog import fills
 * with Desktop originals (their copies already sit at the top of the watched folder).
 * `exclude` (canonical) is a subtree never entered, decided on each folder's realpath: another
 * source's scan never walks into the primary Triage folder nested inside it (ticket 15).
 */
import { readdirSync, realpathSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { isMovedFolderName } from './backlog-plan'

const SKIP_DIRS = new Set(['.git', 'node_modules', '.Trash', '$RECYCLE.BIN'])

const excluded = (dir: string, exclude: string): boolean => {
  let r: string
  try {
    r = realpathSync.native(dir)
  } catch {
    return true // a folder that cannot be resolved is not entered
  }
  return r === exclude || r.startsWith(`${exclude}/`)
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
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
    const abs = join(dir, e.name)
    if (e.isDirectory()) {
      if (recursive && !isMovedFolderName(e.name)) yield* walk(abs, recursive, exclude)
    } else if (e.isFile()) {
      yield { abs }
    }
  }
}
