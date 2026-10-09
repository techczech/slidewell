// End-to-end: look-alike groups in search ("N versions" cards, collapsed and expanded).
// Needs a scratch profile (copies only): <scratch>/userData/config.json pointing at <scratch>/well, whose
// picture-search.db already holds well-image vectors (the model is not needed for grouping).
//
// Run after `npm run build`:
//   SLIDEWELL_LA_SCRATCH=<scratch> [SLIDEWELL_LA_QUERY=drop] node e2e/look-alike.mjs
// Hidden run (SLIDEWELL_E2E_HIDDEN=1); screenshots go to <scratch>/screens. Never touches the installed app.
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const scratch = process.env.SLIDEWELL_LA_SCRATCH
if (!scratch || !existsSync(join(scratch, 'userData', 'config.json'))) {
  console.error('Set SLIDEWELL_LA_SCRATCH to a folder with userData/config.json, well/ and home/.')
  process.exit(2)
}
const query = process.env.SLIDEWELL_LA_QUERY || 'drop'
const screens = join(scratch, 'screens')
mkdirSync(screens, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) failed++
}

const app = await electron.launch({ args: ['.', `--user-data-dir=${join(scratch, 'userData')}`], env: { ...process.env, HOME: join(scratch, 'home'), SLIDEWELL_E2E_HIDDEN: '1' } })
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
process.exit(failed ? 1 : 0)
