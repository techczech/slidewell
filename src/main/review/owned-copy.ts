/**
 * The one way review code deletes a file: a copy SlideWell made itself (a well copy, its sidecar, a
 * video poster). Every deletion checks, in order:
 *
 *   1. the path is not a symlink (lstat) and is a regular file;
 *   2. it has a single hard link (a copy SlideWell wrote; a hard link could share an original's data);
 *   3. its real path (symlinked folders resolved) lies inside one of SlideWell's own copy folders,
 *      themselves resolved with realpath.
 *
 * Anything else is refused and left in place. Originals live in his source folders, never inside
 * these copy folders, so no original can pass.
 */
import { lstatSync, realpathSync, unlinkSync } from 'node:fs'
import { sep } from 'node:path'

export type RemoveResult = { removed: true; path: string } | { removed: false; path: string; reason: 'missing' | 'symlink' | 'not-a-file' | 'linked' | 'outside' | 'error' }

function realRoot(root: string): string | null {
  try {
    return realpathSync(root)
  } catch {
    return null
  }
}

/** True when `real` is strictly inside one of `roots` (all already resolved). */
function inside(real: string, roots: string[]): boolean {
  return roots.some((r) => real.startsWith(r.endsWith(sep) ? r : r + sep))
}

export function removeOwnedCopy(path: string, ownedRoots: string[]): RemoveResult {
  let st
  try {
    st = lstatSync(path)
  } catch {
    return { removed: false, path, reason: 'missing' }
  }
  if (st.isSymbolicLink()) return { removed: false, path, reason: 'symlink' }
  if (!st.isFile()) return { removed: false, path, reason: 'not-a-file' }
  if (st.nlink > 1) return { removed: false, path, reason: 'linked' }
  let real: string
  try {
    real = realpathSync(path)
  } catch {
    return { removed: false, path, reason: 'error' }
  }
  const roots = ownedRoots.map(realRoot).filter((r): r is string => Boolean(r))
  if (!inside(real, roots)) return { removed: false, path, reason: 'outside' }
  try {
    unlinkSync(real)
    return { removed: true, path }
  } catch {
    return { removed: false, path, reason: 'error' }
  }
}
