// End-to-end: two synthetic well images group into one card and expand again.
// Run: npm run test:look-alike
import { finish, recordFailure } from './support/result.mjs'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { createScratch, launchHidden } from './support/scratch.mjs'

const scratch = createScratch('look')
const well = join(scratch, 'well')
const userData = join(scratch, 'userData')
const images = join(well, 'images')
mkdirSync(userData)
mkdirSync(images, { recursive: true })
writeFileSync(join(userData, 'config.json'), JSON.stringify({ wellRoot: well }))
const query = 'fixture'
const records = new DatabaseSync(join(well, 'well.db'))
const vectors = new DatabaseSync(join(well, 'picture-search.db'))
try {
  records.exec(`CREATE VIRTUAL TABLE well_fts USING fts5(id UNINDEXED, slug UNINDEXED, ext UNINDEXED,
    rel_path UNINDEXED, root UNINDEXED, source UNINDEXED, tags, notes, ocr_text, added_at UNINDEXED)`)
  vectors.exec(`CREATE TABLE vectors (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, presentation_id TEXT, slide_order INTEGER, well_id TEXT,
    path TEXT NOT NULL, file_size INTEGER NOT NULL, file_mtime_ms INTEGER NOT NULL,
    embedded_at TEXT NOT NULL, vector BLOB NOT NULL
  )`)
  const addRecord = records.prepare("INSERT INTO well_fts VALUES (?, ?, 'webp', ?, 'well', 'screenshot', '', 'fixture', '', ?)")
  const addVector = vectors.prepare("INSERT INTO vectors VALUES (?, 'well-image', NULL, NULL, ?, ?, ?, ?, ?, ?)")
  const vector = new Float32Array(768)
  vector[0] = 1
  const now = new Date().toISOString()
  for (const [id, background] of [['aaaaaaa', '#1d4ed8'], ['bbbbbbb', '#1e40af']]) {
    const rel = `images/fixture--${id}.webp`
    const path = join(well, rel)
    await sharp({ create: { width: 640, height: 400, channels: 3, background } }).webp().toFile(path)
    const stat = statSync(path)
    addRecord.run(id, 'fixture', rel, now)
    addVector.run(`well:${id}`, id, path, stat.size, Math.round(stat.mtimeMs), now, Buffer.from(vector.buffer))
  }
} finally {
  vectors.close()
  records.close()
}

const screens = join(scratch, 'screens')
mkdirSync(screens, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) {
    recordFailure(name)
    failed++
  }
}

const app = await launchHidden(userData, join(scratch, 'home'))
try {
  let win = null
  for (let i = 0; i < 300 && !win; i++) {
    win = app.windows().find((w) => !w.url().startsWith('swembed:') && w.url() !== 'about:blank') ?? null
    if (!win) await sleep(100)
  }
  if (!win) throw new Error('main window did not open')
  await win.waitForLoadState('domcontentloaded')
  await win.setViewportSize({ width: 1400, height: 900 }).catch(() => undefined)
  const run = (cluster) =>
    win.evaluate(
      async ([q, cluster]) => {
        const filters = { owner: 'all', era: 'all', category: '', deck: '', role: 'all', cluster, from: 'screenshots', kind: 'all', type: 'images', library: 'all' }
        const r = await window.sw.archive.search(q, filters)
        return r.map((c) => ({ size: c.size, lookAlike: c.lookAlike ?? null, ids: c.members.map((m) => m.reference) }))
      },
      [query, cluster]
    )
  const off = await run(false)
  const on = await run(true)
  console.log(`grouping off: ${off.length} results; on: ${on.length} cards, sizes ${on.map((c) => c.size).join(',')}`)
  check('grouping off: every result is its own card', off.length > 0 && off.every((c) => c.size === 1))
  check('grouping on: at least one look-alike group', on.some((c) => c.size > 1 && c.lookAlike))
  check('grouping on: no result is lost or duplicated', on.reduce((n, c) => n + c.size, 0) === off.length)
  check('grouping on: fewer cards than results', on.length < off.length)

  // the UI: type the query, From = Well (chip), grouping on
  await win.locator('.searchbar .search-input').fill(query)
  await sleep(900)
  await win.waitForFunction(() => !document.querySelector('.results-head')?.textContent?.includes('loading'), null, { timeout: 60000 })
  const chip = win.locator('.chips[aria-label="From"] >> text=/^\\s*Screenshots/')
  if (await chip.count()) await chip.first().click()
  await win.locator('.filterbar select').nth(0).selectOption('all').catch(() => undefined)
  const toggle = win.locator('.filterbar .toggle', { hasText: 'Group near-identical' })
  if (!(await toggle.evaluate((el) => el.classList.contains('on')).catch(() => false))) await toggle.click()
  await sleep(1200)
  const badges = win.locator('.badge.clickable')
  const n = await badges.count()
  const texts = await badges.allInnerTexts()
  check('UI shows "N versions" badges', n > 0 && texts.every((t) => /^▸ \d+ versions$/.test(t.trim())), texts.join(' | '))
  await win.screenshot({ path: join(screens, 'look-alike-collapsed.png') })
  await badges.first().click()
  await win.waitForSelector('.modal .grid .card', { timeout: 5000 })
  const head = await win.locator('.modal-head').innerText()
  const members = await win.locator('.modal .grid .card').count()
  check('expanding shows every version', members >= 2 && head.includes(`${members} versions`), `${head.trim()} / ${members}`)
  await sleep(500)
  await win.screenshot({ path: join(screens, 'look-alike-expanded.png') })
} finally {
  await app.close()
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS')
finish(failed ? 'assertion failed' : null)
