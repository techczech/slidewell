import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'

const GROUPS_PER_LABEL = 32
const UNDECIDED = 12

function captureArt(group, frame, title) {
  // Vary the whole scene across groups. Frames within a group differ only by a small marker.
  const palette = ['#0d2742', '#803e35', '#403265', '#283d18', '#b4842b', '#352833', '#47666a', '#423018']
  const background = palette[group % palette.length]
  const hue = (group * 137) % 360
  const accent = `hsl(${hue}, 72%, 47%)`
  const layout = Math.floor(group / palette.length) % 8
  const marks = Array.from({ length: 11 }, (_, i) => {
    const x = 25 + ((group * 79 + i * (61 + group)) % 560)
    const y = 73 + ((group * 43 + i * 59) % 268)
    const width = 27 + ((group * 23 + i * 37) % 145)
    const fill = i % 2 ? accent : '#fff3d6'
    if (layout === 0 || layout === 5) return `<circle cx="${x}" cy="${y}" r="${width / 3}" fill="${fill}"/>`
    if (layout === 1 || layout === 6) return `<rect x="${x}" y="${y}" width="${width / 3}" height="${width}" fill="${fill}"/>`
    if (layout === 2 || layout === 7) return `<path d="M${x} ${y}l${width} 25 -55 50z" fill="${fill}"/>`
    return `<rect x="${x}" y="${y}" width="${width}" height="18" fill="${fill}"/>`
  }).join('')
  return Buffer.from(`<svg width="640" height="360" xmlns="http://www.w3.org/2000/svg">
    <rect width="640" height="360" fill="${background}"/>
    ${marks}
    <text x="28" y="43" font-size="23" font-family="sans-serif" fill="#fff3d6">${title}</text>
    <circle cx="${610 + frame * 8}" cy="28" r="3" fill="#fff3d6"/>
  </svg>`)
}

export async function makeSorterFixture(root) {
  const source = join(root, 'captures')
  const well = join(root, 'well')
  const images = join(well, 'images')
  mkdirSync(source)
  mkdirSync(images, { recursive: true })

  const triageDb = new DatabaseSync(join(well, 'triage.db'))
  const wellDb = new DatabaseSync(join(well, 'well.db'))
  const originals = new Map()
  try {
    triageDb.exec(`
      CREATE VIRTUAL TABLE triage_fts USING fts5(
        hash UNINDEXED, kind UNINDEXED, rel_path UNINDEXED, filename, ext UNINDEXED,
        size UNINDEXED, mtime UNINDEXED, poster_rel UNINDEXED, offline UNINDEXED, ocr_text, scanned_at UNINDEXED,
        source UNINDEXED, taken_at UNINDEXED, app, window_title
      );
      CREATE TABLE triage_decisions (hash TEXT PRIMARY KEY, state TEXT NOT NULL, decided_at TEXT, well_id TEXT);
    `)
    wellDb.exec(`
      CREATE VIRTUAL TABLE well_fts USING fts5(
        id UNINDEXED, slug UNINDEXED, ext UNINDEXED, rel_path UNINDEXED,
        root UNINDEXED, source UNINDEXED, tags, notes, ocr_text, added_at UNINDEXED
      );
    `)
    const addCapture = triageDb.prepare(`INSERT INTO triage_fts VALUES (
      ?, 'image', ?, ?, 'png', ?, ?, NULL, '0', ?, ?, ?, ?, ?, ?
    )`)
    const decide = triageDb.prepare('INSERT INTO triage_decisions VALUES (?, ?, ?, ?)')
    const addWell = wellDb.prepare(`INSERT INTO well_fts VALUES (
      ?, ?, 'webp', ?, 'well', 'screenshot', 'fixture', '', ?, ?
    )`)
    const labelledGroups = 2 * GROUPS_PER_LABEL
    for (let group = 0; group < labelledGroups + UNDECIDED; group++) {
      const state = group >= labelledGroups ? null : group % 2 === 0 ? 'included' : 'excluded'
      const app = group % 2 === 0 ? 'Fableglass Studio' : 'Copperfin Desk'
      const title = `Field notebook ${group + 1}`
      for (let frame = 0; frame < (state ? 2 : 1); frame++) {
        const time = new Date(Date.UTC(2025, 4, 1, 9, group * 11 + frame)).toISOString()
        const slug = `capture-${group + 1}-${frame + 1}`
        const filename = slug + '.png'
        const path = join(source, filename)
        const bytes = await sharp(captureArt(group, frame, title)).png().toBuffer()
        writeFileSync(path, bytes)
        const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12)
        originals.set(path, hash)
        const { size, mtimeMs } = statSync(path)
        addCapture.run(hash, filename, filename, size, Math.round(mtimeMs), title, time, source, time.slice(0, 19), app, title)
        if (state === 'included') {
          const rel = `images/${slug}--${hash}.webp`
          await sharp(bytes).webp().toFile(join(well, rel))
          addWell.run(hash, slug, rel, title, time)
        }
        if (state) decide.run(hash, state, time, state === 'included' ? hash : null)
      }
    }
  } finally {
    triageDb.close()
    wellDb.close()
  }

  return {
    well,
    undecided: UNDECIDED,
    originalsUnchanged: () => [...originals].every(([path, hash]) =>
      createHash('sha256').update(readFileSync(path)).digest('hex').startsWith(hash))
  }
}
