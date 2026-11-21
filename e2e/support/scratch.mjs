import { constants, cpSync, lstatSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
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

export function launchHidden(userData, home, { args = [], ...options } = {}) {
  mkdirSync(home, { recursive: true })
  return electron.launch({
    ...options,
    args: ['.', `--user-data-dir=${userData}`, ...args],
    env: { ...process.env, HOME: home, SLIDEWELL_DATA_DIR: userData, SLIDEWELL_E2E_HIDDEN: '1' }
  })
}
