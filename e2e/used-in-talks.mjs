// End-to-end: "Used in talks". Builds a scratch fixture vault (one talk, two pooled images), launches
// SlideWell on a scratch profile, adds an image reference to the talk, relaunches, and checks the
// From chip, the card line and the inspector's Used in box. The fixture vault is the only thing written.
//
// Run after `npm run build`:
//   SLIDEWELL_UIT_SCRATCH=<empty scratch folder outside the repo> node e2e/used-in-talks.mjs
// Screenshots go to <scratch>/screens. Hidden run (SLIDEWELL_E2E_HIDDEN=1), own HOME and user-data-dir.
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'

const scratch = process.env.SLIDEWELL_UIT_SCRATCH
if (!scratch) {
  console.error('Set SLIDEWELL_UIT_SCRATCH to a scratch folder outside the repo.')
  process.exit(2)
}
const archive = process.env.SLIDEWELL_UIT_ARCHIVE || join(scratch, 'no-archive')
const screens = join(scratch, 'screens')
const vault = join(scratch, 'vault')
const userData = join(scratch, 'userData')
const home = join(scratch, 'home')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) failed++
}

for (const d of [vault, userData, home, join(scratch, 'well')]) rmSync(d, { recursive: true, force: true })
for (const d of [join(vault, '_assets'), join(vault, 'sample-talk'), userData, home, screens]) mkdirSync(d, { recursive: true })
for (const [id, rgb] of [['aaaaaaa', '#2b6cb0'], ['bbbbbbb', '#c05621']]) {
  await sharp({ create: { width: 640, height: 400, channels: 3, background: rgb } }).webp().toFile(join(vault, '_assets', `img-${id}.webp`))
  writeFileSync(join(vault, '_assets', `img-${id}.yml`), `id: img-${id}\nalt: ""\ncaption: "sample ${id}"\ntags: []\n`)
}
const talk = join(vault, 'sample-talk', 'sample-talk-outline.md')
const talkText = (extra) => `---\ntitle: Teaching with AI: a staff briefing\nauto_title_slide: false\n---\n\n### Opening\n\n### The robot\n${extra}\n`
writeFileSync(talk, talkText(''))
writeFileSync(join(userData, 'config.json'), JSON.stringify({ archiveRoot: archive, wellRoot: join(scratch, 'well'), othersArchiveRoot: join(scratch, 'others'), vaultRoot: vault }), 'utf8')

async function launch() {
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env: { ...process.env, HOME: home, SLIDEWELL_E2E_HIDDEN: '1' } })
  let win = null
  for (let i = 0; i < 300 && !win; i++) {
    win = app.windows().find((w) => !w.url().startsWith('swembed:') && w.url() !== 'about:blank') ?? null
    if (!win) await sleep(100)
  }
  if (!win) throw new Error('main window did not open')
  await win.waitForLoadState('domcontentloaded')
  return { app, win }
}
const filters = { owner: 'all', era: 'all', category: '', deck: '', role: 'content', cluster: true, from: 'all', kind: 'all', type: 'images', library: 'mine' }
async function untilCounts(win, pred, ms = 60000) {
  const t0 = Date.now()
  let c = null
  while (Date.now() - t0 < ms) {
    c = await win.evaluate((f) => window.sw.archive.fromCounts('', f), filters).catch(() => null)
    if (c && pred(c)) return c
    await sleep(500)
  }
  return c
}
async function refreshResults(win) {
  const box = win.locator('.searchbar .search-input')
  await box.fill('zz')
  await sleep(500)
  await box.fill('')
  await sleep(900)
}

// run 1: the talk has no image reference yet
let { app, win } = await launch()
try {
  const c = await untilCounts(win, (x) => x.screenshots >= 2)
  check('both vault images are catalogued', c?.screenshots >= 2, JSON.stringify(c))
  check('no talk uses them yet: count 0', c?.talks === 0, JSON.stringify(c))
  check('the chip is disabled while nothing is used', await win.locator('.fromrow .chip', { hasText: 'Used in talks' }).isDisabled())
} finally {
  await app.close()
}

// the user adds an image to the talk, then relaunches
const before = readFileSync(join(vault, '_assets', 'img-aaaaaaa.webp')).length
writeFileSync(talk, talkText('![A friendly robot](img-aaaaaaa)'))

;({ app, win } = await launch())
try {
  const c = await untilCounts(win, (x) => x.talks >= 1)
  check('after relaunch one picture is used in talks', c?.talks === 1, JSON.stringify(c))
  await refreshResults(win)
  const chip = win.locator('.fromrow .chip', { hasText: 'Used in talks' })
  check('the Used in talks chip is enabled and says 1', (await chip.isEnabled()) && /1/.test((await chip.textContent()) ?? ''))
  await chip.click()
  await sleep(1200)
  const cards = await win.locator('.card').count()
  check('the chip shows exactly the used picture', cards === 1, `${cards} cards`)
  const pill = (await win.locator('.card .badge.talks').first().textContent().catch(() => '')) ?? ''
  check("the card says 'used in 1 talk'", pill.trim() === 'used in 1 talk', pill)
  await win.screenshot({ path: join(screens, 'used-in-talks-card.png') })
  await win.locator('.card').first().click()
  await win.waitForSelector('.deck-sidebar', { timeout: 5000 }).catch(async () => {
    await win.keyboard.press('i')
    await win.waitForSelector('.deck-sidebar', { timeout: 5000 })
  })
  const box = ((await win.locator('.used-in-box').first().textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
  check("the inspector says 'Teaching with AI: a staff briefing (slide 2)'", box.startsWith('Teaching with AI: a staff briefing (slide 2)'), box)
  check('the inspector offers to show the talk file', /Show talk file/.test(box), box)
  await win.screenshot({ path: join(screens, 'used-in-talks-inspector.png') })
  const revealed = await win.evaluate(() => window.sw.archive.revealTalk('../../etc/hosts'))
  check('a path outside the vault is refused', revealed === false)
  const after = readFileSync(join(vault, '_assets', 'img-aaaaaaa.webp')).length
  check('the image pool is untouched', after === before)
} finally {
  await app.close()
}
const talkNow = readFileSync(talk, 'utf8')
check('the talk file is exactly what the user wrote (SlideWell never writes to the vault)', talkNow === talkText('![A friendly robot](img-aaaaaaa)'))
if (existsSync(join(vault, 'well.db')) || existsSync(join(vault, 'sample-talk', 'well.db'))) check('no database in the vault', false)
console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
process.exit(failed ? 1 : 0)
