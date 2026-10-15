/**
 * The swarchive:// guard (index.ts): which absolute path a swarchive://f/<base64url> URL names, and whether it may
 * be served, copied or revealed. No Electron here, so the checks are testable.
 *
 * Two checks, both needed:
 *   decodeSwUrlPath  the path as written is under an allowed root (lexical; also for a file not here yet,
 *                    which an R2-backed store fetches into place)
 *   realUnderRoots   the file exists and its real path (every symlink followed) is under an allowed root's
 *                    real path: a link inside a root that leads outside every root is refused
 * Serving, both clipboard copies and reveal use the real-path check on the file they would hand out;
 * servableUnderRoots is the two together for a path already decoded (serving, and Review's picture chooser, which
 * must only pick a copy the protocol will serve).
 * A file fetched from R2 into place (serveSwFile) is checked before anything is written too:
 *   writableUnderRoots  nothing is at the path (not even a dangling link) and the real path of its nearest
 *                       existing parent folder is under an allowed root's real path
 * and once the bytes are down, folderUnderRoots re-checks the folder before they are moved into place (storage.ts).
 */
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'

/** A root's real path (symlinks followed); the root as written when it does not exist here. */
export function realRoot(root: string): string {
  try {
    return realpathSync(root)
  } catch {
    return resolve(root)
  }
}

/**
 * True when `abs` exists and its real path (every symlink followed) is inside one of `realRoots`
 * (already real: realRoot). A link inside a root that points outside every root is not inside, and a
 * file that does not exist is not inside either.
 */
export function realInside(realRoots: string[], abs: string): boolean {
  let t: string
  try {
    t = realpathSync(abs)
  } catch {
    return false
  }
  return realRoots.some((r) => t.startsWith(r.endsWith(sep) ? r : r + sep))
}

// The b64url payload lives in the URL PATH, not the host: URL hosts are lowercased by spec, which would corrupt
// case-sensitive base64url. Host is a constant 'f'.
function decodeB64Url(s: string): string {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}
function encodeB64Url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function swUrlOf(abs: string | null): string | null {
  return abs ? `swarchive://f/${encodeB64Url(abs)}` : null
}

const lexicallyUnder = (roots: string[], abs: string): boolean => roots.some((r) => resolve(abs).startsWith(resolve(r) + sep))

/** The path a swarchive URL names, when it is written under one of `roots` (it may not exist here); else null. */
export function decodeSwUrlPath(url: string, roots: string[]): string | null {
  try {
    const abs = decodeB64Url(new URL(url).pathname.replace(/^\/+/, ''))
    return lexicallyUnder(roots, abs) ? abs : null
  } catch {
    return null
  }
}

/** True when `abs` exists and its real path is under the real path of one of `roots`. */
export function realUnderRoots(abs: string, roots: string[]): boolean {
  return realInside(roots.map(realRoot), abs)
}

/**
 * True when swarchive:// would serve `abs`: it is under one of `roots` as written (the lexical check
 * decodeSwUrlPath applies) and it exists with its real path under the real path of one of `roots`.
 */
export function servableUnderRoots(abs: string, roots: string[]): boolean {
  return lexicallyUnder(roots, abs) && realUnderRoots(abs, roots)
}

/** The file a swarchive URL names, when it exists here and passes both checks; else null (copy, reveal). */
export function resolveSwUrlReal(url: string, roots: string[]): string | null {
  const abs = decodeSwUrlPath(url, roots)
  return abs && existsSync(abs) && servableUnderRoots(abs, roots) ? abs : null
}

/**
 * True when the real path of `dir` is the real path of one of `roots` or under it: a folder a fetch may write in
 * (checked before the fetch on the nearest existing folder, and again on the destination folder before the move).
 */
export function folderUnderRoots(dir: string, roots: string[]): boolean {
  let real: string
  try {
    real = realpathSync(dir)
  } catch {
    return false
  }
  return roots.map(realRoot).some((r) => real === r || real.startsWith(r.endsWith(sep) ? r : r + sep))
}

/**
 * The path to write at, when `p` is absolute with no '..' segment; else null. A '..' after a link is resolved by the
 * filesystem from the link's target (mkdir and open follow the link first), while resolve() drops it lexically, so
 * the two would name different folders: such a path is never written to. The result (resolve() of a path with no
 * '..', which only tidies '.' and repeated separators) is the one path every later step uses.
 */
export function plainWritePath(p: string): string | null {
  if (!isAbsolute(p) || p.split(/[\\/]/).includes('..')) return null
  return resolve(p)
}

/**
 * True when a file may be written at `abs` (an R2 fetch into the local cache): `abs` is absolute with no '..'
 * segment (plainWritePath), nothing is there, not even a link
 * (writing through a dangling link would land at its target), and the nearest existing folder above it has its
 * real path under the real path of one of `roots`, so the folders made below it and the file stay inside.
 */
export function writableUnderRoots(abs: string, roots: string[]): boolean {
  const target = plainWritePath(abs)
  if (target === null) return false // relative, or a '..' segment
  try {
    lstatSync(target)
    return false // something is there already: never written over
  } catch {
    // nothing there: look at the folders above it
  }
  return makeableUnderRoots(dirname(target), roots)
}

/**
 * True when folder `dir` may be made (or already is) under an allowed root: the nearest existing folder at or above
 * it has its real path under the real path of one of `roots`, with no dangling link on the way, so folders made
 * below it stay inside. Checked before every mkdir of a fetch. Refuses a relative path or one with a '..' segment.
 */
export function makeableUnderRoots(dir: string, roots: string[]): boolean {
  const plain = plainWritePath(dir)
  if (plain === null) return false
  let d = plain
  for (;;) {
    if (existsSync(d)) return folderUnderRoots(d, roots)
    try {
      lstatSync(d)
      return false // a dangling link on the way
    } catch {
      // not there yet: made by the fetch
    }
    const up = dirname(d)
    if (up === d) return false
    d = up
  }
}

/**
 * The file to serve for a decoded swarchive path: the local file, or, when it is not here and `fetchInto` is given
 * (an R2-backed store with credentials), the file fetched into place, only after writableUnderRoots allows the
 * write. Either way the file served passes the real-path check; else null (the protocol answers 404).
 */
export async function serveSwFile(abs: string, roots: string[], fetchInto: ((abs: string) => Promise<boolean>) | null): Promise<string | null> {
  if (!existsSync(abs)) {
    if (!fetchInto || !writableUnderRoots(abs, roots)) return null
    if (!(await fetchInto(abs))) return null
  }
  return servableUnderRoots(abs, roots) ? abs : null
}
