/**
 * The Triage source walker: every file under a capture folder (or the top level only), skipping
 * hidden entries, tool folders, and the `Moved by SlideWell <date>` folders the backlog import fills
 * with Desktop originals (their copies already sit at the top of the watched folder).
 */
import { readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { isMovedFolderName } from './backlog-plan'

const SKIP_DIRS = new Set(['.git', 'node_modules', '.Trash', '$RECYCLE.BIN'])

export function* walk(dir: string, recursive = true): Generator<{ abs: string }> {
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
      if (recursive && !isMovedFolderName(e.name)) yield* walk(abs, recursive)
    } else if (e.isFile()) {
      yield { abs }
    }
  }
}
