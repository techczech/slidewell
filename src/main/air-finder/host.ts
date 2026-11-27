import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createCatalogue } from './catalogue-client'
import { finderServer, type FinderQueries } from './server'

type LaunchConfig = {
  libraryId: string; socketPath: string; browserPort: number
  presentations: string[]; wellImages: string[]; meaningVerified?: boolean
}
type LibraryRoots = { archiveRoot(): string; wellRoot(): string }

class FinderStartupError extends Error {
  constructor(message: string, readonly socketPath?: string) {
    super(message)
  }
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
  configPath: string, roots: LibraryRoots, pictures: FinderQueries, onUnavailable?: () => void
) {
  const configUnreadable = 'SlideWell couldn’t read the Air finder settings. Check that the private settings file exists and contains valid JSON.'
  const info = await lstat(configPath).catch(() => { throw new FinderStartupError(configUnreadable) })
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 1024 * 1024) {
    throw new FinderStartupError('The Air finder settings must be in a private file owned by your account. Check the file’s ownership and permissions.')
  }
  let config: unknown
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'))
  } catch {
    throw new FinderStartupError(configUnreadable)
  }
  if (typeof config !== 'object' || !isConfig(config)) {
    throw new FinderStartupError('The Air finder settings are invalid. Check the library selection and connection settings in the private settings file.')
  }

  const socketFolderInvalid = 'The Air finder needs a short path to a private socket folder. Check that the folder exists, belongs to your account and is accessible only to you (mode 0700).'
  const parent = await realpath(dirname(config.socketPath)).catch(() => { throw new FinderStartupError(socketFolderInvalid) })
  const socketPath = join(parent, basename(config.socketPath))
  const directory = await lstat(parent)
  if (directory.uid !== process.getuid?.() || !directory.isDirectory() ||
      (directory.mode & 0o777) !== 0o700 || Buffer.byteLength(socketPath) > 103) {
    throw new FinderStartupError(socketFolderInvalid)
  }
  // The directory protects the socket before, during and after bind. Never replace a prior entry.
  const existing = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (existing) throw new FinderStartupError('A connection file already exists at:', socketPath)
  const archive = roots.archiveRoot()
  const well = roots.wellRoot()
  const catalogue = await createCatalogue({ ...config, archiveRoot: archive, wellRoot: well }, onUnavailable)
  const server = finderServer({
    catalogue, browserPort: config.browserPort,
    pictures: config.meaningVerified ? pictures : undefined,
    available: () => archive === roots.archiveRoot() && well === roots.wellRoot()
  })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    await catalogue.close()
    throw error
  }
  return server
}

export async function startFinderAtLaunch(
  args: readonly string[], roots: LibraryRoots, pictures: FinderQueries,
  warn: (detail: string) => void
) {
  const flag = '--air-finder-config='
  const option = args.find((arg) => arg.startsWith(flag))
  if (!option) return null

  try {
    return await startConfiguredFinder(option.slice(flag.length), roots, pictures, () => {
      warn('The Air finder’s library worker stopped repeatedly. Restart SlideWell to try again.')
    })
  } catch (error) {
    if (error instanceof FinderStartupError) {
      warn(error.socketPath
        ? `${error.message}\n${error.socketPath}\n\nIf another finder is running, quit it first. Move the file to the Bin only after checking that nothing is using it, then restart SlideWell.`
        : error.message)
    } else {
      // OS and parser errors can include private paths or settings.
      warn('SlideWell couldn’t open the Air finder. Check that the selected library and private socket folder are available, then restart SlideWell.')
    }
    return null
  }
}
