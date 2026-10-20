// Rules that span more than one setting, enforced where every change is written. A schema `validate` sees one
// value only, so it cannot keep the Others' Library apart from your own archive; this does, for every writer
// in this process: the app's window and old-shape writes, the CLI (its own store inside runSettingsCli), an
// import, a reset, an undo and a re-migration.
//
// The seam: @bridle/settings' public `beforeWrite` store option (0.2.0). The store calls it once per write, under
// the lock, with the state on disk and the whole state the write would leave, on every route (set, reset, undo,
// import, migration, ...). Every SlideWell store is created with `beforeWrite: libraryFolderRule`: the app's
// (settings-host.ts), the re-migration's (settings-migration.ts) and the CLI's (passed to runSettingsCli).
// No Electron here, so the CLI and the tests share it.
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { BeforeWrite, SettingsState } from '@bridle/settings'

/** Where each library lives when its folder setting is empty (main's readers use the same). */
export const ARCHIVE_DEFAULT = join(homedir(), 'gitrepos', '05_ppt-tools', 'ppt-archive')
export const OTHERS_DEFAULT = join(homedir(), 'SlideWell', 'others-library')

/** The words the old folder chooser showed, for every writer. */
export const OVERLAP_REASON = 'That folder overlaps your own archive. Pick a separate location for the Others’ Library so other people’s slides never mix into your archive.'

/**
 * The folder as the file system sees it: symbolic links followed. The raw path is handed to realpath as typed,
 * so a `..` is taken after the link before it (`other/link/..` with link → mine/child is `mine`), never
 * removed first by string normalising. For a folder that does not exist yet, the longest existing prefix of
 * the raw path is resolved and the rest appended (normalised), so a link anywhere above it still counts.
 */
export function realFolder(p: string): string {
  let head = isAbsolute(p) ? p : process.cwd() + sep + p
  const tail: string[] = []
  for (;;) {
    try {
      return resolve(realpathSync.native(head), ...tail.reverse())
    } catch {
      const up = dirname(head)
      if (up === head) return resolve(p)
      tail.push(basename(head))
      head = up
    }
  }
}

/** `target` is `root` or inside it (`/` contains every folder). */
function within(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
}

/** The same folder, or one inside the other, after following symbolic links. */
export function foldersOverlap(a: string, b: string): boolean {
  const ra = realFolder(a)
  const rb = realFolder(b)
  return within(ra, rb) || within(rb, ra)
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** The two library folders a settings state points at (empty means the default). */
export function libraryRoots(settings: Readonly<Record<string, unknown>>): { archive: string; others: string } {
  return {
    archive: str(settings['library.archiveRoot']) || ARCHIVE_DEFAULT,
    others: str(settings['library.othersRoot']) || OTHERS_DEFAULT
  }
}

/**
 * Why writing `after` (over `before`, the file as read under the lock) is refused, or null. Only a change to
 * either library folder is judged, so a pair that already overlapped (written by an older version) does not
 * block unrelated settings; changing either folder must end in a pair that does not overlap.
 */
export function crossSettingProblem(before: SettingsState, after: SettingsState): string | null {
  const a = libraryRoots(before.settings)
  const b = libraryRoots(after.settings)
  if (a.archive === b.archive && a.others === b.others) return null
  return foldersOverlap(b.archive, b.others) ? OVERLAP_REASON : null
}

/**
 * The store's `beforeWrite` rule. A migration (route `migration`: the store reading the hand-over file that
 * migrateFromConfig wrote) is let through: migrateFromConfig has already left out an Others' Library that
 * overlaps the archive, and what can remain (an archive inside the Others' default folder, with the Others'
 * folder empty) has no non-overlapping value to fall back to; refusing it would refuse the whole migration and
 * show every setting at its default. The use-time check in index.ts refuses Others' imports in that case.
 * Every other route is judged by crossSettingProblem.
 */
export const libraryFolderRule: BeforeWrite = (p) => {
  if (p.route === 'migration') return undefined
  const why = crossSettingProblem(p.before, p.next)
  return why ? { reject: why } : undefined
}
