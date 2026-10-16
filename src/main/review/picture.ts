/**
 * Which copy of a screenshot to show, and why there is no picture when there is none.
 * Several triage rows can share one content hash (the same file at several paths). Review shows the first usable one:
 * a copy that exists on disk, is downloaded, and sits under a root SlideWell may serve; then an existing cloud
 * placeholder; then nothing. A copy whose row says downloaded but whose file is a cloud placeholder on disk now (size > 0, no
 * blocks: the test the triage scan uses, triage.ts) counts as a placeholder too: the scan keeps an unchanged file's row,
 * so a file the cloud provider took back since is only seen here. "Under a root" is exactly the check swarchive:// applies before serving
 * (swarchive-guard.ts servableUnderRoots: under a root as written, and by real path with symlinks followed), so a
 * link that leads outside every root, or an alias outside the roots that leads into one, counts as missing and a
 * copy the protocol will serve wins. Metadata only (existsSync, realpathSync, statSync): no file is ever opened or read.
 */
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { servableUnderRoots } from '../swarchive-guard'
import type { ReviewFile } from './store'

// The real-path helpers live in the guard; re-exported for callers that import them from here.
export { realInside, realRoot } from '../swarchive-guard'

export type PictureState = 'ok' | 'not-downloaded' | 'missing' | 'none'

export type PictureDeps = {
  wellRoot: () => string
  /** Fallback root for rows that carry no source (older scans). */
  sourceRoot: () => string | null
  /** The roots swarchive:// will serve from. Absent: no root check (tests, callers that do not serve). */
  allowedRoots?: () => string[]
  /** A cloud placeholder on disk (size > 0, no blocks). Absent: statSync. A test seam: tests never make real placeholders. */
  dataless?: (abs: string) => boolean
}

/** A file whose name and size are here but whose bytes are not (a cloud placeholder): the triage scan's test. Metadata only. */
export function datalessOnDisk(abs: string): boolean {
  try {
    const st = statSync(abs)
    return st.isFile() && st.size > 0 && st.blocks === 0
  } catch {
    return false
  }
}

/**
 * Positive evidence that a file's bytes are on this Mac: it can be stat'ed, is a regular file, has a size and has blocks
 * on disk. A file that is missing, cannot be stat'ed, is empty or is a placeholder is not (Download them counts only this
 * as downloaded). Metadata only.
 */
export function downloadedOnDisk(abs: string): boolean {
  try {
    const st = statSync(abs)
    return st.isFile() && st.size > 0 && st.blocks > 0
  } catch {
    return false
  }
}

export type PictureChoice = {
  state: PictureState
  /** The file to serve as the picture (ok only). */
  abs: string | null
  /** The original file, when a copy of it exists and may be revealed (ok or not-downloaded). */
  originalAbs: string | null
  /** The folder the first recorded copy was expected in (missing only). */
  expectedDir: string | null
}

/** One call's worth of choices: stat results are remembered per hash, so a card shown twice costs one set of stats. */
export function pictureChooser(deps: PictureDeps): (hash: string, copies: ReviewFile[]) => PictureChoice {
  const memo = new Map<string, PictureChoice>()
  let allowed: string[] | null | undefined // the allowed roots, once per chooser (on first use)
  return (hash, copies) => {
    const hit = memo.get(hash)
    if (hit) return hit
    if (allowed === undefined) allowed = deps.allowedRoots ? deps.allowedRoots() : null
    const roots = allowed
    const originalOf = (f: ReviewFile): string => join(f.source || deps.sourceRoot() || '', f.relPath)
    const shownOf = (f: ReviewFile): string | null => (f.kind === 'video' ? (f.posterRel ? join(deps.wellRoot(), f.posterRel) : null) : originalOf(f))
    // the protocol's own check: a copy swarchive:// would refuse counts as not here
    const found = (abs: string): boolean => (roots === null ? existsSync(abs) : servableUnderRoots(abs, roots))
    const dataless = deps.dataless ?? datalessOnDisk

    let placeholder: string | null = null
    let sawPosterless = false
    for (const f of copies) {
      if (f.offline) {
        const o = originalOf(f)
        if (!placeholder && found(o)) placeholder = o
        continue
      }
      const shown = shownOf(f)
      if (shown === null) {
        sawPosterless = true
        continue
      }
      if (found(shown)) {
        // a picture whose row says downloaded but whose file is a placeholder now is not one to show
        if (f.kind !== 'video' && dataless(shown)) {
          if (!placeholder) placeholder = shown
          continue
        }
        const choice: PictureChoice = { state: 'ok', abs: shown, originalAbs: f.kind === 'video' ? null : shown, expectedDir: null }
        memo.set(hash, choice)
        return choice
      }
    }
    let choice: PictureChoice
    if (placeholder) choice = { state: 'not-downloaded', abs: null, originalAbs: placeholder, expectedDir: null }
    else if (!copies.length || sawPosterless) choice = { state: 'none', abs: null, originalAbs: null, expectedDir: null }
    else choice = { state: 'missing', abs: null, originalAbs: null, expectedDir: dirname(originalOf(copies[0])) }
    memo.set(hash, choice)
    return choice
  }
}
