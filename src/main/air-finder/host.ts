import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createCatalogue } from './catalogue'
import { finderServer, type FinderQueries } from './server'

type LaunchConfig = {
  libraryId: string; socketPath: string; browserPort: number
  presentations: string[]; wellImages: string[]; meaningVerified?: boolean
}

function isConfig(config: Partial<LaunchConfig> | null): config is LaunchConfig {
  const list = (value: unknown, pattern: RegExp) =>
    Array.isArray(value) && value.length <= 10_000 && value.every((id) => typeof id === 'string' && pattern.test(id))
  return Boolean(config &&
    typeof config.libraryId === 'string' && /^[\w-]{1,64}$/.test(config.libraryId) &&
    typeof config.socketPath === 'string' && isAbsolute(config.socketPath) && basename(config.socketPath).endsWith('.sock') &&
    typeof config.browserPort === 'number' && Number.isInteger(config.browserPort) && config.browserPort >= 1024 && config.browserPort <= 65535 &&
    list(config.presentations, /^[a-zA-Z0-9_][\w.-]{0,180}$/) && list(config.wellImages, /^[a-f0-9]{7,64}$/) &&
    (config.presentations!.length || config.wellImages!.length) &&
    (config.meaningVerified === undefined || typeof config.meaningVerified === 'boolean'))
}

/** A local, same-UID endpoint. Browsers reach it through an existing authenticated SSH forward. */
export async function startConfiguredFinder(
  configPath: string, roots: { archiveRoot(): string; wellRoot(): string }, pictures: FinderQueries
) {
  const info = await lstat(configPath)
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 1024 * 1024) {
    throw new Error('Finder config must be a private file')
  }
  const config: unknown = JSON.parse(await readFile(configPath, 'utf8'))
  if (typeof config !== 'object' || !isConfig(config)) throw new Error('Invalid finder scope or connection settings')

  const parent = await realpath(dirname(config.socketPath))
  const socketPath = join(parent, basename(config.socketPath))
  const directory = await lstat(parent)
  if (directory.uid !== process.getuid?.() || !directory.isDirectory() ||
      (directory.mode & 0o777) !== 0o700 || Buffer.byteLength(socketPath) > 103) {
    throw new Error('Finder socket requires a short private directory')
  }
  const archive = roots.archiveRoot()
  const well = roots.wellRoot()
  const catalogue = await createCatalogue({ ...config, archiveRoot: archive, wellRoot: well })
  const server = finderServer({
    catalogue, browserPort: config.browserPort,
    pictures: config.meaningVerified ? pictures : undefined,
    available: () => archive === roots.archiveRoot() && well === roots.wellRoot()
  })

  // The directory protects the socket before, during and after bind. Never replace a prior entry.
  const existing = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (existing) throw new Error('Finder socket already exists')
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
  return server
}
