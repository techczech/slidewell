import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { drainInbox, searchWell } from '../src/main/well'

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

afterEach(() => rmSync(root, { force: true, recursive: true }))

function ready(path: string): void {
  const then = new Date(Date.now() - 10_000)
  utimesSync(path, then, then)
}

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

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

it('indexes an inbox video under its original capture source before deleting it', async () => {
  const original = join(inbox, 'clip.mp4')
  const bytes = Buffer.from('synthetic video bytes')
  writeFileSync(original, bytes)
  ready(original)

  expect(await drainInbox(archive, well)).toBe(1)
  const rows = await searchWell(well, 'screenshot')
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
  const rows = await searchWell(well, 'screenshot')
  expect(rows).toHaveLength(1)
  expect(readFileSync(join(well, rows[0].rel_path)).equals(first)).toBe(true)
})
