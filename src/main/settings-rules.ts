// Rules that span more than one setting, enforced where every change is written. A schema `validate` sees one
// value only, so it cannot keep the Others' Library apart from your own archive; this does, for every writer
// in this process: the app's window and old-shape writes, the CLI (its own store inside runSettingsCli), an
// import, a reset, an undo and a re-migration.
//
// The seam: @bridle/settings' SettingsStore runs every operation as lock → read → op(state on disk) → write
// (its `mutate`). There is no public hook for a cross-setting rule (package follow-up), so installWriteRules
// wraps that one method on the prototype; the rule then judges the state the operation would write, under the
// lock. If the package changes shape, installWriteRules throws at startup instead of silently not guarding.
// No Electron here, so the CLI and the tests share it.
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { OpResult, SettingsState } from '@bridle/settings'
import { SettingsStore } from '@bridle/settings/node'
import { APP_ID } from '../shared/settings-schema'

/** Where each library lives when its folder setting is empty (main's readers use the same). */
export const ARCHIVE_DEFAULT = join(homedir(), 'gitrepos', '05_ppt-tools', 'ppt-archive')
export const OTHERS_DEFAULT = join(homedir(), 'SlideWell', 'others-library')

/** The words the old folder chooser showed, for every writer. */
export const OVERLAP_REASON = 'That folder overlaps your own archive. Pick a separate location for the Others’ Library so other people’s slides never mix into your archive.'

/**
 * The folder as the file system sees it: symbolic links followed. For a folder that does not exist yet, its
 * nearest existing parent is resolved and the rest appended, so a link anywhere above it still counts.
 */
export function realFolder(p: string): string {
  let head = resolve(p)
  const tail: string[] = []
  for (;;) {
    try {
      return join(realpathSync.native(head), ...tail.reverse())
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

type Op = (s: SettingsState) => OpResult
type Mutate = (this: unknown, op: Op) => Promise<unknown>
const INSTALLED = Symbol.for('slidewell.settings-write-rules')

/** Installs the rule on every SlideWell settings store in this process (idempotent). */
export function installWriteRules(): void {
  const proto = SettingsStore.prototype as unknown as { mutate?: Mutate; [INSTALLED]?: true }
  if (proto[INSTALLED]) return
  const inner = proto.mutate
  if (typeof inner !== 'function') throw new Error('SlideWell: @bridle/settings no longer has the write seam the library-folder rule needs')
  proto.mutate = function (this: unknown, op: Op) {
    const app = (this as { opts?: { schema?: { app?: string } } }).opts?.schema?.app
    if (app !== APP_ID) return inner.call(this, op)
    return inner.call(this, (s: SettingsState): OpResult => {
      const r = op(s)
      if (!r.ok) return r
      const why = crossSettingProblem(s, r.state)
      return why ? { ok: false, code: 'invalid-value', error: why } : r
    })
  }
  proto[INSTALLED] = true
}

installWriteRules()
