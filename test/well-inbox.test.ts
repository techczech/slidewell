import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { drainInbox, searchWell } from '../src/main/well'
import { getTriageDecision, listTriage, promoteTriageHashes, scanTriageSource, setTriageDecision } from '../src/main/triage'

vi.mock('node:fs', async (loadOriginal) => {
  const fs = await loadOriginal<typeof import('node:fs')>()
  return { ...fs, renameSync: vi.fn(fs.renameSync) }
})

let root: string
let archive: string
let well: string
let inbox: string

beforeEach(() => {
  mkdirSync('out', { recursive: true })
  root = mkdtempSync(join(process.cwd(), 'out', 'well-inbox-test-'))
  archive = join(root, 'archive')
  well = join(root, 'well')
  inbox = join(well, '_inbox')
  const ocr = join(archive, 'tools', 'ocr')
  mkdirSync(ocr, { recursive: true })
  writeFileSync(join(ocr, 'vision_ocr'), "#!/bin/sh\nprintf '{}\\n'\n", { mode: 0o700 })
  mkdirSync(inbox, { recursive: true })
})

afterEach(() => {
  vi.mocked(renameSync).mockRestore()
  rmSync(root, { force: true, recursive: true })
})

function ready(path: string): void {
  const then = new Date(Date.now() - 10_000)
  utimesSync(path, then, then)
}

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

it('imports a staged screenshot under its original Triage key after the placeholder hydrates', async () => {
  const captures = join(root, 'captures')
  mkdirSync(captures)
  const original = join(captures, 'hydrated-keeper.png')
  const image = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'green' } }).png().toBuffer()
  writeFileSync(original, '')
  truncateSync(original, image.length)
  ready(original)
  const { blocks, atime, mtime } = statSync(original)
  expect(blocks).toBe(0)

  const options = { listing: {}, onlyChanged: true }
  const scan = () => scanTriageSource(archive, well, captures, undefined, options)
  await scan()
  const [placeholder] = await listTriage(well, '', 'all')
  expect(placeholder).toMatchObject({ offline: '1', hash: expect.stringMatching(/^p:/) })
  const { hash } = placeholder
  await setTriageDecision(archive, well, captures, hash, 'select')
  const promote = () => promoteTriageHashes(archive, well, captures, null)
  expect(await promote()).toEqual({ imported: [], skipped: 1, gated: 0 })
  expect(await getTriageDecision(well, hash)).toMatchObject({ state: 'selected', wellId: null })

  writeFileSync(original, image)
  utimesSync(original, atime, mtime)
  await scan()
  expect(await listTriage(well, '', 'all')).toEqual([
    expect.objectContaining({ hash, state: 'selected', offline: '0' })
  ])
  const result = await promote()
  expect(result).toMatchObject({ imported: [{ hash, created: true }], skipped: 0, gated: 0 })
  const [{ wellId, relPath }] = result.imported
  expect(await getTriageDecision(well, hash)).toMatchObject({ state: 'included', wellId })
  expect(await searchWell(well, '')).toEqual([expect.objectContaining({ id: wellId, rel_path: relPath })])
  const stored = readFileSync(join(well, relPath))
  expect(wellId).toBe(digest(stored).slice(0, 7))
  expect(readFileSync(original)).toEqual(image)
  expect(await promote()).toEqual({ imported: [], skipped: 0, gated: 0 })
  expect(await searchWell(well, '')).toHaveLength(1)
})

describe.each(['picture', 'video'])('inbox %s', (kind) => {
  async function fixture() {
    const image = kind === 'picture'
    const source = image
      ? await sharp({ create: { width: 32, height: 32, channels: 3, background: 'green' } }).png().toBuffer()
      : Buffer.from('synthetic video bytes')
    const encoded = image ? await sharp(source).webp({ quality: 82 }).toBuffer() : source
    const stored = encoded.length <= source.length ? encoded : source
    const ext = image ? (stored === encoded ? 'webp' : 'png') : 'mp4'
    const stem = 'screenshot'
    const store = join(well, 'images')
    const dest = join(store, `${stem}--${digest(stored).slice(0, 7)}.${ext}`)
    const original = join(inbox, image ? 'picture.png' : 'video.mp4')
    mkdirSync(store, { recursive: true })
    writeFileSync(original, source)
    ready(original)
    return { dest, original, source, store, stored }
  }

  it('replaces an incomplete stored copy before removing the original', async () => {
    const { dest, original, stored } = await fixture()
    writeFileSync(dest, stored.subarray(0, 1))

    expect(await drainInbox(archive, well)).toBe(1)
    expect(readFileSync(dest).length).toBe(stored.length)
    expect(digest(readFileSync(dest))).toBe(digest(stored))
    expect(existsSync(original)).toBe(false)
  })

  it('repairs a different file of the right size', async () => {
    const { dest, original, store, stored } = await fixture()
    const edit = Buffer.alloc(stored.length, 0x65)
    writeFileSync(dest, edit)

    expect(await drainInbox(archive, well)).toBe(1)
    expect(digest(readFileSync(dest))).toBe(digest(stored))
    expect(existsSync(original)).toBe(false)
    const backups = readdirSync(store).filter((name) => name.includes('.recovered-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(store, backups[0])).equals(edit)).toBe(true)
  })

  it('leaves the original and no partial file when the destination is unwritable', async () => {
    const { dest, original, source, store } = await fixture()
    chmodSync(store, 0o500)
    try {
      expect(await drainInbox(archive, well)).toBe(0)
      expect(readFileSync(original).equals(source)).toBe(true)
      expect(existsSync(dest)).toBe(false)
      expect(readdirSync(store)).toEqual([])
    } finally {
      chmodSync(store, 0o700)
    }
  })
})

it('cleans only stale ingest temp files', async () => {
  const store = join(well, 'images')
  mkdirSync(store)
  const old = '.slidewell-00000000-0000-0000-0000-000000000001.tmp.png'
  const fresh = '.slidewell-00000000-0000-0000-0000-000000000002.tmp.png'
  const other = '.another-process.tmp.png'
  for (const name of [old, fresh, other]) writeFileSync(join(store, name), 'synthetic')
  const then = new Date(Date.now() - 120_000)
  for (const name of [old, other]) utimesSync(join(store, name), then, then)

  expect(await drainInbox(archive, well)).toBe(0)
  expect(readdirSync(store).sort()).toEqual([other, fresh].sort())
})

it('finds an inbox video by its capture filename after its verified copy is stored', async () => {
  const original = join(inbox, 'Exit interview clip.mp4')
  const bytes = Buffer.from('synthetic video bytes')
  writeFileSync(original, bytes)
  ready(original)

  expect(await drainInbox(archive, well)).toBe(1)
  const rows = await searchWell(well, 'interview clip')
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ source: 'screenshot', ext: 'mp4' })
  expect(readFileSync(join(well, rows[0].rel_path)).equals(bytes)).toBe(true)
  expect(existsSync(original)).toBe(false)
})

it('leaves a zero-byte or recent capture in the inbox for another pass', async () => {
  const empty = join(inbox, 'empty.png')
  const recent = join(inbox, 'recent.png')
  writeFileSync(empty, '')
  ready(empty)
  writeFileSync(recent, 'still being written')

  expect(await drainInbox(archive, well)).toBe(0)
  expect(readdirSync(inbox).sort()).toEqual(['empty.png', 'recent.png'])
  ready(recent)
  expect(await drainInbox(archive, well)).toBe(0)
  expect(await drainInbox(archive, well)).toBe(1)
  expect(readdirSync(inbox)).toEqual(['empty.png'])
})

it('keeps both complete files whose SHA-256 prefixes collide', async () => {
  const incoming = Buffer.from('synthetic collision 5476')
  const existing = Buffer.from('synthetic collision 20973')
  expect(digest(incoming).slice(0, 7)).toBe(digest(existing).slice(0, 7))
  expect(digest(incoming)).not.toBe(digest(existing))
  const original = join(inbox, 'collision.png')
  const store = join(well, 'images')
  mkdirSync(store)
  const dest = join(store, `screenshot--${digest(incoming).slice(0, 7)}.png`)
  writeFileSync(original, incoming)
  ready(original)
  writeFileSync(dest, existing)

  expect(await drainInbox(archive, well)).toBe(0)
  expect(readFileSync(original).equals(incoming)).toBe(true)
  expect(readFileSync(dest).equals(existing)).toBe(true)
  expect(readdirSync(store)).toEqual([dest.split('/').at(-1)])
})

it('retains an original replaced while OCR is reading it', async () => {
  const original = join(inbox, 'changing.png')
  const first = Buffer.from('original synthetic bytes')
  writeFileSync(original, first)
  ready(original)
  const ocr = join(archive, 'tools', 'ocr', 'vision_ocr')
  writeFileSync(ocr, '#!/bin/sh\nprintf "updated" >> "$1"\nprintf "{}\\n"\n')

  expect(await drainInbox(archive, well)).toBe(0)
  expect(readFileSync(original).equals(Buffer.concat([first, Buffer.from('updated')]))).toBe(true)
  const rows = await searchWell(well, '')
  expect(rows).toHaveLength(1)
  expect(readFileSync(join(well, rows[0].rel_path)).equals(first)).toBe(true)
})


it('imports a future-dated capture once two passes see it unchanged', async () => {
  const original = join(inbox, 'future.png')
  const bytes = Buffer.from('synthetic future-dated screenshot')
  writeFileSync(original, bytes)
  const future = new Date(Date.now() + 3_600_000)
  utimesSync(original, future, future)
  const retry = vi.fn()

  expect(await drainInbox(archive, well, retry)).toBe(0)
  expect(existsSync(original)).toBe(true)
  expect(retry).toHaveBeenCalledTimes(1)

  expect(await drainInbox(archive, well, retry)).toBe(1)
  expect(existsSync(original)).toBe(false)
  expect(retry).toHaveBeenCalledTimes(1)
})

it('preserves one recovery copy and logs once when a sync client rewrites the destination', async () => {
  const source = Buffer.from('synthetic source bytes')
  const original = join(inbox, 'sync.png')
  const store = join(well, 'images')
  const dest = join(store, `screenshot--${digest(source).slice(0, 7)}.png`)
  const edit = Buffer.from('earlier owner edit')
  const rewritten = Buffer.from('sync-client rewrite')
  mkdirSync(store)
  writeFileSync(original, source)
  ready(original)
  writeFileSync(dest, edit)

  const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(renameSync).mockImplementation((from, to) => {
    fs.renameSync(from, to)
    if (to === dest) writeFileSync(dest, rewritten)
  })
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    for (let pass = 0; pass < 3; pass++) expect(await drainInbox(archive, well)).toBe(0)

    const backups = readdirSync(store).filter((name) => name.includes('.recovered-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(store, backups[0]))).toEqual(edit)
    expect(readFileSync(dest)).toEqual(rewritten)
    expect(readFileSync(original)).toEqual(source)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Recovery copy already exists'))
  } finally {
    log.mockRestore()
  }
})
