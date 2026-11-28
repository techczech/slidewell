import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, lstatSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { MODEL_DIR_NAME, MODEL_FILES, MODEL_REVISION, modelFileUrl } from '../../src/main/picture-search/model-manifest.ts'
import { readVerifiedPictureModel } from './cached-picture-model.mjs'

async function fetchModelFile(path, signal) {
  let url = new URL(modelFileUrl(path))
  for (let redirects = 0; redirects <= 8; redirects++) {
    if (url.protocol !== 'https:' || !/(^|\.)(huggingface\.co|hf\.co)$/.test(url.hostname) ||
        url.username || url.password || url.port) {
      throw new Error(`Unexpected model download host for ${path}: ${url.host}`)
    }
    const response = await fetch(url, { redirect: 'manual', signal })
    if (response.ok && response.body) return Readable.fromWeb(response.body)
    await response.body?.cancel()
    const location = response.headers.get('location')
    if (response.status < 300 || response.status >= 400 || !location) {
      throw new Error(`Model download failed (HTTP ${response.status}) for ${path}`)
    }
    url = new URL(location, url)
  }
  throw new Error(`Too many model download redirects for ${path}`)
}

async function downloadVerifiedFile(directory, { path, size, sha256 }, signal) {
  const destination = join(directory, path)
  mkdirSync(dirname(destination), { recursive: true })
  const hash = createHash('sha256')
  let bytes = 0
  const checkSize = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      if (bytes > size) return callback(new Error(`Model file exceeds its pinned size: ${path}`))
      hash.update(chunk)
      callback(null, chunk)
    }
  })
  console.log(`Downloading pinned model file ${path}`)
  const source = await fetchModelFile(path, signal)
  await pipeline(source, checkSize, createWriteStream(destination, { flags: 'wx' }), { signal })
  if (bytes !== size || hash.digest('hex') !== sha256) throw new Error(`Model file failed verification: ${path}`)
}

async function verifyCache(cache) {
  if (!lstatSync(cache).isDirectory()) throw new Error(`Model cache must be a directory: ${cache}`)
  const verified = readVerifiedPictureModel(cache)
  for (const { path, sha256 } of MODEL_FILES) {
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(join(verified, path))) digest.update(chunk)
    if (digest.digest('hex') !== sha256) throw new Error(`Cached model file failed verification: ${path}`)
  }
  console.log(`Verified pinned model cache: ${cache}`)
  return verified
}

export async function preparePictureModel(root) {
  const cache = join(root, MODEL_DIR_NAME)
  if (lstatSync(cache, { throwIfNoEntry: false })) return verifyCache(cache)

  // Publish only complete, verified files. A failed download leaves its own directory for inspection.
  const incoming = mkdtempSync(join(root, 'model-'))
  console.log(`Preparing pinned model ${MODEL_REVISION} in ${incoming}`)
  const signal = AbortSignal.timeout(30 * 60_000)
  for (const file of MODEL_FILES) await downloadVerifiedFile(incoming, file, signal)
  writeFileSync(join(incoming, 'verified.json'), JSON.stringify({
    revision: MODEL_REVISION,
    files: MODEL_FILES.map(({ path, sha256 }) => ({ path, sha256 })),
    verifiedAt: new Date().toISOString()
  }))
  try {
    renameSync(incoming, cache)
  } catch (error) {
    if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error
    return verifyCache(cache)
  }
  return readVerifiedPictureModel(cache)
}
