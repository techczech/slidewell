/**
 * The model on disk: status, a resumable verified download, and delete.
 *
 * Layout: <modelsRoot>/<MODEL_DIR_NAME>/ holds the pinned files (same relative paths as the
 * Hugging Face repo) plus `verified.json`, written only after every file matched its pinned sha256
 * and size. A file in flight is `<name>.part`; a later download resumes it with an HTTP Range
 * request. Nothing here touches the network except `downloadModel`, and the fetch it uses is
 * passed in by the caller.
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MODEL_DIR_NAME, MODEL_FILES, MODEL_REVISION, MODEL_TOTAL_BYTES, modelFileUrl, type ModelFile } from './model-manifest'

export type ModelState = 'absent' | 'partial' | 'ready'

export type FetchLike = (url: string, init: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  body: ReadableStream<Uint8Array> | null
}>

export type DownloadProgress = { receivedBytes: number; totalBytes: number; file: string }

export function modelDir(modelsRoot: string): string {
  return join(modelsRoot, MODEL_DIR_NAME)
}

const MARKER = 'verified.json'

/** Cheap check (no hashing): ready = marker present and every file at its pinned size. */
export function modelState(dir: string, files: readonly ModelFile[] = MODEL_FILES): ModelState {
  if (!existsSync(dir)) return 'absent'
  const sized = files.every((f) => sizeOf(join(dir, f.path)) === f.size)
  if (sized && existsSync(join(dir, MARKER))) return 'ready'
  const any = files.some((f) => existsSync(join(dir, f.path)) || existsSync(join(dir, `${f.path}.part`)))
  return any ? 'partial' : 'absent'
}

function sizeOf(p: string): number {
  try {
    return statSync(p).size
  } catch {
    return -1
  }
}

/** Bytes already on disk (complete files + partial .part files), for the progress bar on resume. */
export function bytesOnDisk(dir: string, files: readonly ModelFile[] = MODEL_FILES): number {
  let n = 0
  for (const f of files) {
    const done = sizeOf(join(dir, f.path))
    if (done === f.size) n += done
    else n += Math.max(0, Math.min(f.size, sizeOf(join(dir, `${f.path}.part`))))
  }
  return n
}

function hashFile(p: string, h = createHash('sha256')): Promise<ReturnType<typeof createHash>> {
  return new Promise((resolve, reject) => {
    const s = createReadStream(p)
    s.on('data', (d) => h.update(d))
    s.on('end', () => resolve(h))
    s.on('error', reject)
  })
}

/**
 * Download every missing file, verify each against its pinned sha256 + size, then write the marker.
 * Resumes `.part` files. A file whose bytes do not match is deleted and the download fails, so a bad
 * or tampered file never becomes `ready`. Throws on abort, HTTP error or mismatch.
 */
export async function downloadModel(
  dir: string,
  fetchImpl: FetchLike,
  opts: { signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void; files?: readonly ModelFile[]; urlFor?: (path: string) => string; revision?: string } = {}
): Promise<void> {
  const files = opts.files ?? MODEL_FILES
  const urlFor = opts.urlFor ?? modelFileUrl
  const totalBytes = opts.files ? files.reduce((s, f) => s + f.size, 0) : MODEL_TOTAL_BYTES
  mkdirSync(dir, { recursive: true })
  rmSync(join(dir, MARKER), { force: true })
  let received = bytesOnDisk(dir, files)
  const report = (file: string): void => opts.onProgress?.({ receivedBytes: received, totalBytes, file })
  report('')

  for (const f of files) {
    const dest = join(dir, f.path)
    if (sizeOf(dest) === f.size) continue // complete from an earlier run; verified below
    mkdirSync(dirname(dest), { recursive: true })
    const part = `${dest}.part`
    let have = Math.max(0, sizeOf(part))
    if (have > f.size) {
      rmSync(part, { force: true })
      received -= have
      have = 0
    }
    const headers: Record<string, string> = have > 0 ? { Range: `bytes=${have}-` } : {}
    const res = await fetchImpl(urlFor(f.path), { headers, signal: opts.signal })
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${f.path}`)
    if (have > 0 && res.status !== 206) {
      // server ignored the Range request: start this file again
      rmSync(part, { force: true })
      received -= have
      have = 0
    }
    const fd = openSync(part, have > 0 ? 'a' : 'w')
    try {
      const reader = res.body.getReader()
      for (;;) {
        if (opts.signal?.aborted) throw new Error('download cancelled')
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.byteLength === 0) continue
        writeSync(fd, value)
        received += value.byteLength
        report(f.path)
      }
    } finally {
      closeSync(fd)
    }
    if (sizeOf(part) !== f.size) {
      const got = sizeOf(part)
      rmSync(part, { force: true })
      throw new Error(`download of ${f.path} ended at ${got} bytes, expected ${f.size}`)
    }
    renameSync(part, dest)
  }

  // Verify every file against its pinned hash (complete files from an earlier run included).
  for (const f of files) {
    const p = join(dir, f.path)
    const digest = (await hashFile(p)).digest('hex')
    if (digest !== f.sha256 || sizeOf(p) !== f.size) {
      rmSync(p, { force: true })
      throw new Error(`${f.path} failed verification (sha256 ${digest.slice(0, 12)}…, expected ${f.sha256.slice(0, 12)}…); it was deleted`)
    }
  }
  writeFileSync(join(dir, MARKER), JSON.stringify({ revision: opts.revision ?? MODEL_REVISION, files: files.map((f) => ({ path: f.path, sha256: f.sha256 })), verifiedAt: new Date().toISOString() }, null, 2))
}

/** Remove the model folder entirely (vectors already written stay in the store). */
export function deleteModel(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/** Read a verified model file as text (tokenizer + processor configs). */
export function readModelText(dir: string, path: string): string {
  return readFileSync(join(dir, path), 'utf8')
}
