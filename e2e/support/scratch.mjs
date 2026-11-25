import { constants, cpSync, lstatSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

// SLIDEWELL_E2E_EXECUTABLE=<.app>/Contents/MacOS/SlideWell walks a packaged candidate instead of the source build.
const packaged = process.env.SLIDEWELL_E2E_EXECUTABLE

export function launchHidden(userData, home, { args = [], isolatePreferences = false, ...options } = {}) {
  mkdirSync(home, { recursive: true })
  const env = { ...process.env, HOME: home, SLIDEWELL_DATA_DIR: userData, SLIDEWELL_E2E_HIDDEN: '1' }
  if (isolatePreferences) {
    // Capture-folder discovery shells out to macOS defaults. Keep it away from the user's preferences.
    const bin = join(home, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'defaults'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
    env.PATH = [bin, env.PATH].filter(Boolean).join(':')
    env.CFFIXED_USER_HOME = home
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.SLIDEWELL_E2E_EXECUTABLE
  return electron.launch({
    ...options,
    ...(packaged ? { executablePath: packaged } : {}),
    args: [...(packaged ? [] : ['.']), `--user-data-dir=${userData}`, '--use-mock-keychain', ...args],
    env
  })
}
