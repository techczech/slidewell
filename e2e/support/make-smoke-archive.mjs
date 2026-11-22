// Generate a self-contained Core A fixture. Print its path for SLIDEWELL_SMOKE_ARCHIVE.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const output = fileURLToPath(new URL('../../out/upkeep-smoke/', import.meta.url))
mkdirSync(output, { recursive: true })
const archive = mkdtempSync(join(output, 'archive-'))
const registry = join(archive, 'registry')
mkdirSync(registry)
const slides = new DatabaseSync(join(registry, 'slides.db'))
const images = new DatabaseSync(join(registry, 'images.db'))
const media = new DatabaseSync(join(registry, 'media.db'))

const decks = [
  { title: 'The Paper Observatory', year: 2025, colour: '#224d72', topics: ['Comets', 'Calendars', 'Lanterns', 'Orbits', 'Sundials', 'Telescopes'] },
  { title: 'The Imaginary Botanic Garden', year: 2024, colour: '#326446', topics: ['Ferns', 'Orchids', 'Seeds', 'Mosses', 'Bark', 'Ponds'] },
  { title: 'Patterns on a Make-believe Coast', year: 2023, colour: '#805550', topics: ['Pebbles', 'Harbours', 'Shells', 'Beacons', 'Tides', 'Boats'] }
]

try {
  slides.exec(`
    CREATE TABLE slides (content_hash TEXT PRIMARY KEY, title TEXT, text_content TEXT);
    CREATE TABLE slide_locations (content_hash TEXT, presentation_id TEXT, slide_order INTEGER, role TEXT);
    CREATE VIRTUAL TABLE slides_fts USING fts5(title, text_content);
    CREATE TABLE ocr_text (asset_key TEXT, presentation_id TEXT, slide_order INTEGER, kind TEXT, text_content TEXT);
    CREATE VIRTUAL TABLE ocr_fts USING fts5(text_content);
  `)
  images.exec(`
    CREATE TABLE images (sha256 TEXT PRIMARY KEY);
    CREATE TABLE image_locations (sha256 TEXT, presentation_id TEXT);
  `)
  media.exec(`
    CREATE TABLE ocr_assets (asset_key TEXT, presentation_id TEXT, rel_path TEXT, text TEXT, kind TEXT, line_count INTEGER);
  `)
  const addSlide = slides.prepare('INSERT INTO slides VALUES (?, ?, ?)')
  const addLocation = slides.prepare('INSERT INTO slide_locations VALUES (?, ?, ?, ?)')
  const addFts = slides.prepare('INSERT INTO slides_fts (rowid, title, text_content) VALUES (?, ?, ?)')
  const addImage = images.prepare('INSERT INTO images VALUES (?)')
  const addImageLocation = images.prepare('INSERT INTO image_locations VALUES (?, ?)')
  const addOcr = media.prepare("INSERT INTO ocr_assets VALUES (?, ?, ?, ?, 'image', 1)")

  for (const [index, { title, year, colour, topics }] of decks.entries()) {
    const pid = 'smoke-deck-' + (index + 1)
    const extracted = join(archive, 'extracted', pid)
    const renders = join(extracted, 'renders')
    const assetPath = 'assets/sample.webp'
    const metadata = { title, created_date: year + '-03-15', ownership: 'mine', category: 'Smoke fixtures' }
    mkdirSync(renders, { recursive: true })
    mkdirSync(join(extracted, 'assets'))
    const create = { width: 640, height: 360, channels: 3, background: colour }
    const picture = await sharp({ create }).webp().toBuffer()
    writeFileSync(join(extracted, assetPath), picture)
    const hash = 'embedded-' + pid
    addImage.run(hash)
    addImageLocation.run(hash, pid)
    addOcr.run(hash, pid, assetPath, 'Synthetic classroom image for ' + title)

    const sections = [{ slides: [] }]
    for (const [i, topic] of topics.entries()) {
      const order = i + 1
      const text = topic + ' dyslexia classroom practice'
      const key = pid + '-' + order
      const { lastInsertRowid } = addSlide.run(key, topic, text)
      addLocation.run(key, pid, order, i === 0 ? 'structural' : 'content')
      addFts.run(lastInsertRowid, topic, text)
      sections[0].slides.push({ order, title: topic, content: [{ type: 'text', text }, { type: 'image', src: assetPath }] })
      writeFileSync(join(renders, 'slide_' + String(order).padStart(4, '0') + '.webp'), picture)
    }
    writeFileSync(join(extracted, 'presentation.json'), JSON.stringify({ metadata, sections }, null, 2))
  }
} finally {
  slides.close()
  images.close()
  media.close()
}
console.log(archive)
