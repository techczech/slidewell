import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'

export const WORDS_QUERY = 'lantern'
export const NO_WORDS_QUERY = 'glowing beacons beside a crescent moon'
export const UNRENDERED_TITLE = 'Lantern lantern lantern field notes'
const OWNER = 'Aster Quill'
const DECKS = ['Amber Harbour', 'Birch Island', 'Copper Reef', 'Driftwood Bay', 'Ember Cove', 'Flint Point']

async function renderSlide(path, deck, order) {
  const hue = 196 + deck * 15
  const x = 74 + (order * 37 + deck * 55) % 430
  const svg = `<svg width="640" height="360" xmlns="http://www.w3.org/2000/svg">
    <rect width="640" height="360" fill="hsl(${hue}, 51%, 22%)"/>
    <path d="M0 286L137 219l151 73 153-53 199 60v61H0z" fill="hsl(${hue}, 43%, 30%)"/>
    <circle cx="530" cy="68" r="37" fill="#fff3cc"/>
    <circle cx="545" cy="56" r="35" fill="hsl(${hue}, 51%, 22%)"/>
    <rect x="${x}" y="130" width="83" height="147" rx="16" fill="#e8a246"/>
    <rect x="${x + 16}" y="154" width="51" height="96" rx="11" fill="#fff5cd"/>
    <path d="M${x - 13} 145l54-59 55 59" fill="#b47d3b"/>
    <text x="24" y="49" font-size="25" font-family="sans-serif" fill="#fff3cc">${DECKS[deck]} · ${order}</text>
  </svg>`
  await sharp(Buffer.from(svg)).webp().toFile(path)
}

export async function makeSearchArchive(archive, { slidesPerDeck = 2, includeUnrendered = false } = {}) {
  const registry = join(archive, 'registry')
  mkdirSync(registry, { recursive: true })
  const slides = new DatabaseSync(join(registry, 'slides.db'))
  const images = new DatabaseSync(join(registry, 'images.db'))
  const media = new DatabaseSync(join(registry, 'media.db'))
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
    const addLocation = slides.prepare("INSERT INTO slide_locations VALUES (?, ?, ?, 'content')")
    const addFts = slides.prepare('INSERT INTO slides_fts (rowid, title, text_content) VALUES (?, ?, ?)')

    for (const [deck, title] of DECKS.entries()) {
      const pid = `fixture-deck-${deck + 1}`
      const extracted = join(archive, 'extracted', pid)
      const renders = join(extracted, 'renders')
      mkdirSync(renders, { recursive: true })
      const metadata = { title, author: OWNER, created_date: `2025-04-${10 + deck}`, category: 'Invented coastal survey' }
      const sections = [{ slides: [] }]
      const unrenderedOrder = includeUnrendered && deck === 0 ? slidesPerDeck + 1 : null
      for (let order = 1; order <= (unrenderedOrder ?? slidesPerDeck); order++) {
        const unrendered = order === unrenderedOrder
        const heading = unrendered ? UNRENDERED_TITLE : `${deck < 2 && order === 1 ? 'Lantern survey' : 'Coastal chart'} ${deck + 1}.${order}`
        const body = unrendered ? 'Lantern lantern lantern record.' : `Observation ${deck + 1}.${order} on the invented shoreline.`
        const key = `${pid}-${order}`
        const { lastInsertRowid } = addSlide.run(key, heading, body)
        addLocation.run(key, pid, order)
        addFts.run(lastInsertRowid, heading, body)
        sections[0].slides.push({ order, title: heading, content: [{ type: 'text', text: body }] })
        if (!unrendered) await renderSlide(join(renders, `slide_${String(order).padStart(4, '0')}.webp`), deck, order)
      }
      writeFileSync(join(extracted, 'presentation.json'), JSON.stringify({ metadata, sections }))
    }
  } finally {
    slides.close()
    images.close()
    media.close()
  }
  return DECKS.length * slidesPerDeck
}

export function writeSearchProfile(root, userData) {
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'config.json'), JSON.stringify({
    archiveRoot: join(root, 'archive'),
    wellRoot: join(root, 'well'),
    othersArchiveRoot: join(root, 'no-others'),
    vaultRoot: join(root, 'no-vault'),
    ownerNames: [OWNER]
  }))
}

export async function waitForSearchIndex(win, expected) {
  await win.waitForFunction(async (total) => {
    const status = await window.sw.picture.status()
    if (status.model !== 'ready') throw new Error(`local picture model is ${status.model}`)
    if (status.index.phase === 'error') throw new Error(`fixture indexing failed: ${status.index.error}`)
    if (status.index.phase !== 'done') return false
    if (status.index.total !== total || status.index.failed) {
      throw new Error(`fixture index incomplete: ${JSON.stringify(status.index)}`)
    }
    return true
  }, expected, { timeout: 120000 })
}
