import { constants, cpSync, lstatSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron } from 'playwright'

// A short path leaves room for the app's Unix socket beneath userData.
export function createScratch(name) {
  const prefix = `sw-${name}-`
  const socket = join(tmpdir(), prefix + 'XXXXXX', 'userData', 'picture-query.sock')
  const base = Buffer.byteLength(socket) < 104 ? tmpdir() : '/tmp'
  const root = mkdtempSync(join(base, prefix))
  process.once('exit', () => rmSync(root, { recursive: true, force: true }))
  return root
}

export function copyFixture(source, target) {
  cpSync(source, target, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
    preserveTimestamps: true,
    filter: (path) => {
      if (lstatSync(path).isSymbolicLink()) throw new Error(`Fixture contains a symlink: ${path}`)
      return true
    }
  })
}

export function copyIndexedSearchFixture(fixture, scratch) {
  for (const folder of ['well', 'userData/models', 'sample-archive']) {
    copyFixture(join(fixture, folder), join(scratch, folder))
  }
  const oldWell = realpathSync(join(fixture, 'well'))
  const archive = realpathSync(join(scratch, 'sample-archive'))
  const well = realpathSync(join(scratch, 'well'))
  const index = new DatabaseSync(join(well, 'picture-search.db'))
  try {
    const from = index.prepare("SELECT value FROM meta WHERE key = 'slide_archive_root'").get()?.value
    if (!from) throw new Error('Indexed Search fixture has no recorded archive root')
    // The vectors describe these same files. Give the copy its new root and file coordinates.
    for (const table of ['vectors', 'failures']) {
      const rebase = index.prepare(`UPDATE ${table} SET path = ? || substr(path, length(?) + 1) WHERE substr(path, 1, length(?) + 1) = ? || '/'`)
      rebase.run(archive, from, from, from)
      rebase.run(well, oldWell, oldWell, oldWell)
    }
    index.prepare("UPDATE meta SET value = ? WHERE key = 'slide_archive_root'").run(archive)
  } finally {
    index.close()
  }
}

export function launchHidden(userData, home, { args = [], ...options } = {}) {
  mkdirSync(home, { recursive: true })
  const env = { ...process.env, HOME: home, SLIDEWELL_DATA_DIR: userData, SLIDEWELL_E2E_HIDDEN: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  return electron.launch({
    ...options,
    args: ['.', `--user-data-dir=${userData}`, '--use-mock-keychain', ...args],
    env
  })
}
