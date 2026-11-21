import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function collectTarballs(manifest) {
  const tarballs = new Map()
  function visit(value) {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) visit(child)
    } else if (typeof value === 'string' && value.startsWith('file:./vendor/app-patterns/')) {
      const name = value.slice('file:./vendor/app-patterns/'.length)
      const match = /^app-patterns-([a-z0-9]+(?:-[a-z0-9]+)*)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\.tgz$/.exec(name)
      if (!match) throw new Error(`Invalid App Patterns tarball: ${value}`)
      tarballs.set(name, { name, pkg: `@app-patterns/${match[1]}`, version: match[2] })
    }
  }
  for (const section of ['dependencies', 'devDependencies', 'overrides']) visit(manifest[section])
  return [...tarballs.values()]
}

export function verifyIntegrity(bytes, integrity, name) {
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) {
    throw new Error(`Missing or invalid sha512 integrity in package-lock.json for ${name}`)
  }
  const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  if (actual !== integrity) throw new Error(`Integrity mismatch for ${name}; refusing tarball`)
}

export async function fetchAppPatterns(root, download = fetch) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  const directory = join(root, 'vendor/app-patterns')
  for (const { name, pkg, version } of collectTarballs(manifest)) {
    const integrity = lock.packages?.[`node_modules/${pkg}`]?.integrity
    const destination = join(directory, name)
    let existing
    try {
      existing = await readFile(destination)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (existing !== undefined) {
      verifyIntegrity(existing, integrity, name)
      console.log(`Verified ${name} (existing)`)
      continue
    }
    // Reject missing lockfile integrity before making any network request.
    if (!integrity) throw new Error(`Missing sha512 integrity in package-lock.json for ${name}`)
    await mkdir(directory, { recursive: true })
    const temporary = `${destination}.${randomUUID()}.tmp`
    const url = `https://github.com/techczech/app-patterns/releases/download/v${version}/${name}`
    try {
      const response = await download(url)
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} downloading ${url}`)
      await writeFile(temporary, Buffer.from(await response.arrayBuffer()), { flag: 'wx' })
      verifyIntegrity(await readFile(temporary), integrity, name)
      await rename(temporary, destination)
      console.log(`Fetched and verified ${name}`)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fetchAppPatterns(fileURLToPath(new URL('../', import.meta.url))).catch(error => {
    console.error(`fetch-app-patterns: ${error.message}`)
    process.exitCode = 1
  })
}
