// Review screen UI through the renderer mock (ticket 08): the renderer runs under plain Vite with the
// browser mock of window.sw (src/renderer/src/review-mock.ts, which uses the real pile state machine)
// and is driven in chrome-headless-shell. No Electron, no real data.
//
// Run: node e2e/review-ui.mjs        Screenshots: only when SLIDEWELL_REVIEW_SCREENS names a folder
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..', 'src', 'renderer')
const screens = process.env.SLIDEWELL_REVIEW_SCREENS ? resolve(process.env.SLIDEWELL_REVIEW_SCREENS) : null
if (screens) mkdirSync(screens, { recursive: true })
const shoot = (page, name) => (screens ? page.screenshot({ path: join(screens, name) }) : Promise.resolve())
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ' - ' + detail}`)
  if (!ok) failed++
}

const server = await createServer({ configFile: false, root, plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const url = server.resolvedUrls.local[0]
// headless: true runs Playwright's chrome-headless-shell build, never an installed Chrome
const browser = await chromium.launch({ headless: true })
console.log(`browser: ${browser.version()} (headless shell)`)
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(url)
  await page.waitForSelector('.view-switch')

  const h1 = () => page.locator('.rv-head h1').innerText()
  const current = () => page.locator('.rv-big').getAttribute('data-hash')
  const keyAndSettle = async (k) => {
    await page.keyboard.press(k)
    await page.waitForTimeout(150)
  }

  await page.locator('.view-switch .scope-tab', { hasText: 'Review' }).click()
  await page.waitForSelector('.rv-big')
  const ov = await page.evaluate(() => window.sw.review.overview())
  check('opens on the doubtful queue: "N need a look"', (await h1()) === `${ov.needALook} need a look`, await h1())
  check('the Review tab carries the count', (await page.locator('.view-switch .rv-tab-n').innerText()) === String(ov.needALook))
  check('"M sorted confidently" from proposals he has not overridden', (await page.locator('.rv-head .rv-sub').innerText()) === `${ov.confident.kept + ov.confident.throwaway} sorted confidently`)
  check('one large card: file name, app · window, reason, Keep K / Throwaway T',
    (await page.locator('.rv-fn').innerText()).includes('ChatGPT') &&
    (await page.locator('.rv-am').innerText()) === 'Google Chrome · ChatGPT' &&
    (await page.locator('.rv-why').innerText()).startsWith('A ChatGPT window') &&
    (await page.locator('.rv-btn-big.keep').innerText()).includes('Keep') &&
    (await page.locator('.rv-btn-big.toss').innerText()).includes('bin in 30 days'))
  check('up-next list shows the next five', (await page.locator('.rv-up').count()) === 5)
  check('confident strip is collapsed with kept and throwaway counts', (await page.locator('.rv-strip-row').innerText()).includes(`${ov.confident.kept} kept`) && (await page.locator('.rv-strip-body').count()) === 0)
  await shoot(page, 'review-ui-1-doubtful.png')

  const first = await current()
  await keyAndSettle('k')
  check('K keeps: the count drops and the next card shows', (await h1()) === `${ov.needALook - 1} need a look` && (await current()) !== first)
  await keyAndSettle('Meta+z')
  check('⌘Z undoes the last decision and brings the card back', (await h1()) === `${ov.needALook} need a look` && (await current()) === first)
  await keyAndSettle('t')
  const afterT = await page.evaluate(() => window.sw.review.piles())
  check('T throws away: the item is in Throwaway with bin in 30 days', afterT.throwaway.items.some((c) => c.hash === first && c.binInDays === 30 && c.by === 'you'))
  await keyAndSettle('Meta+z')
  check('⌘Z after T restores it to the queue', (await h1()) === `${ov.needALook} need a look` && (await current()) === first)
  await keyAndSettle('ArrowDown')
  const skippedTo = await current()
  check('↓ skips: next card, nothing written, count unchanged', skippedTo !== first && (await h1()) === `${ov.needALook} need a look`)
  await keyAndSettle('ArrowUp')
  check('↑ goes back to the skipped card', (await current()) === first)
  await page.locator('.titlebar-actions .tb-btn[title^="Keyboard shortcuts"]').click()
  await keyAndSettle('k')
  check('a panel open over Review owns the keyboard (K does nothing)', (await h1()) === `${ov.needALook} need a look` && (await current()) === first)
  await page.locator('.overlay').click({ position: { x: 5, y: 5 } })

  await page.locator('.rv-strip-row').click()
  check('the strip expands to show what was sorted confidently', (await page.locator('.rv-strip-body .rv-sample').count()) > 0)
  await page.locator('.rv-strip-row').click()

  await page.locator('.rv-pile-btn').click()
  await page.waitForSelector('.rv-pl-left')
  const p0 = await page.evaluate(() => window.sw.review.piles())
  check('"Show both piles" opens the two-pile view', (await h1()) === 'Both piles')
  check('slide material on the left, newest first, with "you kept" tags', (await page.locator('.rv-pl-left .rv-count').innerText()) === `${p0.kept.total} · newest first` && (await page.locator('.rv-pc .rv-tag.you').count()) >= 1)
  check('throwaway on the right with "bin in N days"', (await page.locator('.rv-tr em').first().innerText()) === 'bin in 30 days' && (await page.locator('.rv-tr').count()) === p0.throwaway.total)
  await shoot(page, 'review-ui-2-both-piles.png')

  const focused = () => page.locator('.rv-focus').getAttribute('data-hash')
  const k0 = await focused()
  await keyAndSettle('ArrowRight')
  const k1 = await focused()
  check('→ moves the focus within slide material', k1 && k1 !== k0 && k1 === p0.kept.items[1].hash)
  await keyAndSettle('ArrowDown')
  check('↓ moves a row down (four across)', (await focused()) === p0.kept.items[5].hash)
  await keyAndSettle('ArrowUp')
  await keyAndSettle('t')
  const p1 = await page.evaluate(() => window.sw.review.piles())
  check('T on slide material moves it to Throwaway', p1.throwaway.items.some((c) => c.hash === k1) && p1.kept.total === p0.kept.total - 1)
  await keyAndSettle('Meta+z')
  const p2 = await page.evaluate(() => window.sw.review.piles())
  check('⌘Z puts it back', p2.kept.total === p0.kept.total && !p2.throwaway.items.some((c) => c.hash === k1))
  await keyAndSettle('Tab')
  const t0 = await focused()
  check('Tab switches to the Throwaway pile', t0 === p2.throwaway.items[0].hash)
  await keyAndSettle('k')
  const p3 = await page.evaluate(() => window.sw.review.piles())
  check('K on a throwaway rescues it into slide material', p3.kept.items.some((c) => c.hash === t0 && c.by === 'you') && p3.throwaway.total === p2.throwaway.total - 1)
  await keyAndSettle('Meta+z')

  await page.locator('.rv-bin-row .rv-link').click()
  const binN = (await page.evaluate(() => window.sw.review.piles())).bin.total
  check('the Bin holds items past 30 days', binN > 0 && (await page.locator('.rv-tr').count()) === binN && (await page.locator('.rv-tr em').first().innerText()) === 'in the Bin')
  await page.locator('.rv-empty-btn').click()
  check('Empty Bin asks first', (await page.locator('.rv-confirm').count()) === 1 && (await page.locator('.rv-confirm').innerText()).includes('Your original files are not touched'))
  await shoot(page, 'review-ui-3-empty-bin-confirm.png')
  await page.locator('.rv-cancel').click()
  check('Cancel empties nothing', (await page.evaluate(() => window.sw.review.piles())).bin.total === binN)
  await page.locator('.rv-tr').first().click()
  await keyAndSettle('k')
  const p4 = await page.evaluate(() => window.sw.review.piles())
  check('K in the Bin rescues the item', p4.bin.total === binN - 1)
  await page.locator('.rv-empty-btn').click()
  await page.locator('.rv-danger').click()
  await page.waitForTimeout(200)
  check('confirming empties the Bin', (await page.evaluate(() => window.sw.review.piles())).bin.total === 0)
  await keyAndSettle('Escape')
  check('Esc goes back to the doubtful queue', (await h1()).endsWith('need a look'))
  check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser.close()
  await server.close()
}
console.log(failed ? `${failed} FAILED` : 'all passed')
process.exit(failed ? 1 : 0)
