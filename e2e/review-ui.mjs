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
    (await page.locator('.rv-why').innerText()).startsWith('Looks like other screenshots you threw away from Google Chrome') &&
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
  const confirmText = await page.locator('.rv-confirm').innerText()
  check('Empty Bin asks first, with the exact count and "SlideWell never deletes your files"', confirmText.includes(`Hide ${binN} screenshot`) && confirmText.includes('Emptying the Bin hides these for good. SlideWell never deletes your files.'))
  check('the Bin footer says emptying only hides', (await page.locator('.rv-pl-right .rv-pl-note').innerText()).includes('SlideWell never deletes your files'))
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

  // --- Teach the sorter (ticket 23): strip, switch, certainty, what moved, the reading ---
  const mockDo = (fn, arg) => page.evaluate(fn, arg)
  const strip = () => page.locator('.ts-strip')
  const stripText = async () => (await strip().innerText()).replace(/\s+/g, ' ').trim()
  const needNow = (await page.evaluate(() => window.sw.review.overview())).needALook
  check('strip counting: choices, need a look, "retrains after every 10 answers (6 to go)"', (await strip().getAttribute('data-kind')) === 'counting' && (await stripText()).startsWith(`Sorter: 312 choices · ${needNow} need a look · retrains after every 10 answers (6 to go)`), await stripText())
  await shoot(page, 'teach-1-strip-counting.png')
  check('"Teaches most first" is on and the main card is the one the sorter is least sure of', (await page.locator('.rv-teach-switch').getAttribute('aria-checked')) === 'true' && (await current()) === (await page.evaluate(() => window.sw.review.overview({ order: 'teach' }))).queue[0].hash)
  check('the main card says how sure: "Leaning throwaway, 52% sure", a split bar and the position', (await page.locator('.rv-cert-head').innerText()) === 'Leaning throwaway, 52% sure' && (await page.locator('.rv-cbar .k').evaluate((e) => e.style.width)) === '48%' && (await page.locator('.rv-cert-note').innerText()).includes('Question 1 of') && (await page.locator('.rv-cert-note').innerText()).includes('most unsure first') && (await page.locator('.rv-cert-note').innerText()).includes('sure at 90%'), await page.locator('.rv-cert-note').innerText())
  check('up-next cards carry a mini bar each', (await page.locator('.rv-up .rv-mini').count()) === 5)
  check('the header says "most unsure first"', (await page.locator('.rv-next h3').innerText()).toLowerCase().includes('most unsure first'))
  const teachOrder = await page.locator('.rv-up').evaluateAll((els) => els.map((e) => e.getAttribute('data-hash')))
  await page.locator('.rv-teach-switch').click()
  await page.waitForTimeout(200)
  const newestOrder = await page.locator('.rv-up').evaluateAll((els) => els.map((e) => e.getAttribute('data-hash')))
  check('switching it off orders the queue newest first, and it is remembered', (await page.locator('.rv-teach-switch').getAttribute('aria-checked')) === 'false' && newestOrder.join() !== teachOrder.join() && newestOrder.join() === (await page.evaluate(() => window.sw.review.overview({ order: 'newest' }))).queue.slice(1, 6).map((c) => c.hash).join() && (await page.evaluate(() => localStorage.getItem('sw.review.teachFirst'))) === 'off')
  await page.reload()
  await page.locator('.view-switch .scope-tab', { hasText: 'Review' }).click()
  await page.waitForSelector('.rv-big')
  check('after a reload the switch is still off', (await page.locator('.rv-teach-switch').getAttribute('aria-checked')) === 'false')
  await page.locator('.rv-teach-switch').click()
  await page.waitForTimeout(150)

  await mockDo(() => window.__sorterMock.preset('retraining'))
  await page.waitForSelector('.ts-strip[data-kind=retraining]')
  check('strip retraining: says so and offers no button', (await stripText()).includes('retraining by itself after ten answers on 312 choices') && (await page.locator('.ts-btn').count()) === 0)
  await shoot(page, 'teach-2-strip-retraining.png')
  await mockDo(() => window.__sorterMock.preset('waiting'))
  await page.waitForSelector('.ts-strip[data-kind=waiting]')
  check('strip waiting for power: "10 answers are waiting" and Retrain now', (await stripText()).includes('10 answers are waiting. It retrains when the Mac is plugged in.') && (await page.locator('.ts-btn').innerText()) === 'Retrain now')
  await shoot(page, 'teach-3-strip-waiting-for-power.png')
  await mockDo(() => window.__sorterMock.preset('off'))
  await page.waitForSelector('.ts-strip[data-kind=off]')
  check('strip with automatic retraining off: the answers since training and a Retrain button', (await stripText()).includes('retraining by itself is off (7 answers since it last trained)') && (await page.locator('.ts-btn').innerText()) === 'Retrain')
  await mockDo(() => window.__sorterMock.preset('few'))
  await page.waitForSelector('.ts-strip[data-kind=few]')
  check('strip with too few choices: how many more it needs, no button', (await stripText()).includes('Sorter: 40 choices') && (await stripText()).includes('it needs 52 more choices before it can learn from them') && (await page.locator('.ts-btn').count()) === 0)
  await mockDo(() => window.__sorterMock.preset('waiting'))
  await page.waitForSelector('.ts-strip[data-kind=waiting]')
  await page.locator('.ts-btn').click()
  await page.waitForSelector('.ts-strip[data-kind=retraining]')
  check('Retrain now asks for a manual retrain, and the strip shows it running', JSON.stringify(await mockDo(() => window.__sorterMock.calls.retrainNow)) === '["manual"]' && (await stripText()).includes('retraining now'))
  await page.waitForSelector('.ts-strip.ts-open')
  const slot = (name) => page.locator(`[data-testid=retrain-notice] [data-slot=${name}]`)
  const slots = () => page.locator('[data-testid=retrain-notice] [data-slot]').evaluateAll((els) => els.map((e) => e.getAttribute('data-slot')))
  const needAtRetrain = (await page.evaluate(() => window.sw.review.overview())).needALook
  check('after a retrain the strip shows one notice made of slots: when, choices learned from, unsure ones now sure (keep / throwaway), still need a look', JSON.stringify(await slots()) === '["when","learnedFrom","moved","stillNeed"]' && (await slot('when').innerText()).startsWith('Retrained today at') && (await slot('learnedFrom').innerText()) === 'using 322 of your choices.' && (await slot('moved').innerText()) === 'Of the screenshots it was unsure about, 23 are now sure: 19 to keep, 4 to throw away.' && (await slot('stillNeed').innerText()) === `Screenshots still needing a look: ${needAtRetrain}.`, JSON.stringify(await slots()))
  check('"Show them" and Dismiss are on the notice; the countdown is a separate quieter piece, not in the notice', (await page.locator('[data-testid=retrain-notice] .ts-moved').innerText()) === 'Show them' && (await page.locator('.ts-dismiss').count()) === 1 && (await page.locator('[data-testid=retrain-countdown]').innerText()) === 'Next retrain after 10 more answers' && !(await page.locator('[data-testid=retrain-notice]').innerText()).includes('Next retrain'))
  await shoot(page, 'teach-4-strip-after-retrain.png')
  await page.locator('.ts-moved').click()
  await page.waitForSelector('.mv-head')
  await page.waitForFunction(() => document.querySelectorAll('.rv-pc').length > 0)
  check('See what moved narrows Review to those screenshots, with a way back', (await page.locator('.mv-head h1').innerText()) === 'What moved' && (await page.locator('.rv-pc').count()) === 12 && (await page.locator('.rv-pc .rv-lbl').first().innerText()).startsWith('now '))
  await shoot(page, 'teach-5-what-moved.png')
  await page.locator('.rv-back-btn').click()
  await page.waitForSelector('.rv-big')
  check('Back to review returns to the queue and the strip', (await h1()).endsWith('need a look') && (await page.locator('.ts-strip.ts-open').count()) === 1)
  await page.locator('.ts-dismiss').click()
  check('Dismiss closes the expanded strip and it stays closed after a reload', (await page.locator('.ts-strip.ts-open').count()) === 0 && (await strip().getAttribute('data-kind')) === 'counting')
  await page.reload()
  await page.locator('.view-switch .scope-tab', { hasText: 'Review' }).click()
  await page.waitForSelector('.rv-big')
  const seenAt = await page.evaluate(() => localStorage.getItem('sw.review.retrainSeen'))
  const retrainWith = (patch) => page.evaluate(async (p) => { window.__sorterMock.preset('retrained'); const r = (await window.sw.sorter.status()).lastRetrain; window.__sorterMock.set({ lastRetrain: { ...r, ...p } }) }, patch)
  await retrainWith({ at: seenAt })
  await page.waitForTimeout(100)
  check('a retrain he has already dismissed does not reopen the strip', (await page.locator('.ts-strip.ts-open').count()) === 0)
  await retrainWith({ at: new Date(Date.now() + 1000).toISOString(), needALook: null, movedToSure: null, movedHashes: [] })
  await page.waitForSelector('.ts-strip.ts-open')
  check('when what moved could not be checked, its own slot says so, and there is nothing to show', JSON.stringify(await slots()) === '["when","learnedFrom","notChecked","stillNeed"]' && (await page.locator('[data-testid=retrain-notice] .ts-moved').count()) === 0, JSON.stringify(await slots()))
  await page.locator('.ts-dismiss').click()
  await retrainWith({ at: new Date(Date.now() + 2000).toISOString(), movedToSure: { keep: 0, throwaway: 0 }, needALook: { before: 41, after: 41 }, movedHashes: [] })
  await page.waitForSelector('.ts-strip.ts-open')
  check('when nothing moved, the notice says so through its own slot', JSON.stringify(await slots()) === '["when","learnedFrom","nothingMoved","stillNeed"]' && (await slot('nothingMoved').innerText()).length > 0 && (await page.locator('[data-testid=retrain-notice] .ts-moved').count()) === 0, JSON.stringify(await slots()))
  await shoot(page, 'teach-4b-strip-nothing-moved.png')
  await page.locator('.ts-dismiss').click()

  // About the sorter: the round "i" in the strip opens one panel; Esc, its close button and a click outside close it; focus goes back to the button
  const info = page.locator('.ts-strip button[aria-label="About the sorter"]')
  check('a round "i" button named "About the sorter" sits in the strip beside "How many is enough?"', (await info.count()) === 1 && (await info.innerText()) === 'i' && (await page.locator('.ts-strip .ts-enough + .sa-info').count()) === 1)
  await info.click()
  const about = page.locator('[role=dialog][aria-label="About the sorter"]')
  await about.waitFor()
  const heads = await about.locator('h3').allInnerTexts()
  check('the panel has the six sections in order', JSON.stringify(heads) === JSON.stringify(['What it looks at', 'Where it learns from', 'How training works', 'How the rules by app and window are made', 'Where it is stored', 'What leaves your Mac']), JSON.stringify(heads))
  const live = (k) => about.locator(`[data-slot=${k}] dd`).innerText()
  check('live numbers: choices kept / thrown away, when it last trained, when it counts as sure, the retrain setting', (await live('choices')) === '312 (228 kept, 84 thrown away)' && (await live('lastTrained')).startsWith('today at') && (await live('sureAt')) === 'keep 80%, throwaway 90%' && (await live('retrain')) === 'on, after every 10 answers, not on battery', [await live('choices'), await live('lastTrained'), await live('sureAt'), await live('retrain')].join(' | '))
  check('opening it moves focus inside the panel', await page.evaluate(() => !!document.activeElement?.closest('[aria-label="About the sorter"][role=dialog]')))
  await shoot(page, 'about-1-panel-from-review.png')
  const beforeAbout = await current()
  await page.keyboard.press('k')
  await page.waitForTimeout(100)
  check('K does nothing while the panel is open', (await current()) === beforeAbout && (await about.count()) === 1)
  await page.keyboard.press('Escape')
  check('Esc closes it and focus returns to the "i" button', (await about.count()) === 0 && (await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'About the sorter')
  await info.click()
  await about.waitFor()
  await about.locator('.tr-popover-close').click()
  check('its close button closes it and focus returns to the button', (await about.count()) === 0 && (await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'About the sorter')
  await info.click()
  await about.waitFor()
  await page.locator('.sa-overlay').click({ position: { x: 5, y: 5 } })
  check('a click outside closes it and focus returns to the button', (await about.count()) === 0 && (await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'About the sorter')

  // the reading as a popover
  await mockDo(() => { window.__sorterMock.preset('counting'); window.__sorterMock.learningDelayMs = 1200 })
  await page.locator('.ts-enough').click()
  await page.waitForSelector('.tr-popover')
  check('while the reading is being worked out a quiet line says so, and the rest is there', (await page.locator('.sr-working').count()) === 1 && (await page.locator('.sr-teach').count()) === 1 && (await page.locator('.sr-headline').innerText()) === '312 choices so far.')
  await shoot(page, 'teach-6-reading-working.png')
  await page.waitForSelector('.lc-svg')
  check('the reading: verdict sentence, then the line under it', (await page.locator('.sr-headline').innerText()) === '312 choices so far. More would still help.' && (await page.locator('.sr-sub').innerText()) === 'Over the last 62 choices, throwaway accuracy hardly changed but the share it is unsure about fell by 2.5 points.')
  const svg = await page.locator('.lc-svg').evaluate((e) => ({ label: e.getAttribute('aria-label'), text: e.textContent, circles: e.querySelectorAll('circle').length, lines: e.querySelectorAll('polyline').length }))
  check('chart: inline SVG, six points on each line, minimum marked, values readable as text', svg.circles === 12 && svg.lines === 2 && svg.text.includes('Minimum: 92') && svg.text.includes('Too few to sort') && svg.text.includes('13.5%') && svg.text.includes('89.5%') && svg.label.includes('At 312 choices: throwaway right 91%, need a look 13.5%'), JSON.stringify(svg).slice(0, 300))
  check('the same values are in a table for a screen reader', (await page.locator('.lc-sr tbody tr').count()) === 6 && (await page.locator('.lc-sr tbody tr').last().innerText()).replace(/\s+/g, ' ') === '312 91% 13.5%')
  check('gains between points (steps differ, so not "per extra N"), balance bar in words, the Teach button', (await page.locator('.sr-gains').innerText()).includes('+9, +4, +2.5, +1, +0.5') && (await page.locator('.sr-balance').innerText()).includes('228 kept') && (await page.locator('.sr-balance').innerText()).includes('84 thrown away') && (await page.locator('.sr-teach').innerText()) === 'Teach the sorter (10)')
  check('the word "binned" and "deck" appear nowhere in the popover', !/binned|\bdeck\b/i.test(await page.locator('.tr-popover').innerText()))
  await shoot(page, 'teach-7-reading-popover.png')
  const before = await current()
  await page.keyboard.press('k')
  await page.waitForTimeout(100)
  check('K does nothing while the popover is open', (await current()) === before)
  await page.locator('.tr-popover').press('Escape')
  check('Esc closes the popover and the focus returns to its link', (await page.locator('.tr-popover').count()) === 0 && (await page.evaluate(() => document.activeElement?.className)).includes('ts-enough'))
  // Esc works from a keyboard-only open (focus is moved into the dialog), a click outside closes it, and focus goes back to the link
  await page.locator('.ts-enough').click()
  await page.waitForSelector('.tr-popover')
  check('opening the reading moves focus inside the dialog', await page.evaluate(() => !!document.activeElement?.closest('.tr-popover')))
  await page.keyboard.press('Escape')
  check('Esc closes it with no click inside first, and focus returns to "How many is enough?"', (await page.locator('.tr-popover').count()) === 0 && (await page.evaluate(() => document.activeElement?.className)).includes('ts-enough'))
  await page.locator('.ts-enough').click()
  await page.waitForSelector('.tr-popover')
  await page.locator('.tr-pop-overlay').click({ position: { x: 5, y: 5 } })
  check('a click outside closes the reading', (await page.locator('.tr-popover').count()) === 0)

  // chart edge cases: nothing overlaps at 100%, at 0%, nor on the real shape that showed the collisions; the verdict copy states the real span
  const overlaps = () => page.locator('.lc-svg').evaluate((svg) => {
    const boxes = [...svg.querySelectorAll('text')].map((t) => ({ t: t.textContent, r: t.getBoundingClientRect() }))
    const bad = []
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].r, b = boxes[j].r
        if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) bad.push(`${boxes[i].t} / ${boxes[j].t}`)
      }
    const sv = svg.getBoundingClientRect()
    const cut = boxes.filter(({ r }) => r.left < sv.left - 0.5 || r.right > sv.right + 0.5 || r.top < sv.top - 0.5 || r.bottom > sv.bottom + 0.5).map((b) => b.t)
    return { bad, cut }
  })
  for (const [name, file] of [['all100', 'fix-chart-all-100.png'], ['all0', 'fix-chart-all-0.png'], ['real', 'fix-chart-real-shape.png']]) {
    await mockDo((nm) => { window.__sorterMock.learning = window.__sorterMock.fixtures[nm]; window.__sorterMock.set({ learnable: { kept: 284, binned: 396 } }) }, name)
    await page.locator('.ts-enough').click()
    await page.waitForSelector('.tr-popover .lc-svg')
    const o = await overlaps()
    check(`chart "${name}": no label overlaps another and none is cut off`, o.bad.length === 0 && o.cut.length === 0, JSON.stringify(o))
    if (name === 'real') {
      check('real shape: headline and sub-line say the sorter is still unsure and give the real figures', (await page.locator('.sr-headline').innerText()) === '680 choices so far. More answers have stopped helping.' && (await page.locator('.sr-sub').innerText()) === 'On its own the sorter is still unsure about 69 in 100 screenshots. The rules by app and window settle many of those.', await page.locator('.sr-headline').innerText())
      check('real shape: the gains line uses the real step (113 or 114), not 50', (await page.locator('.sr-gains').innerText()).startsWith('Throwaway right per extra 113 choices'), await page.locator('.sr-gains').innerText())
    }
    await shoot(page, file)
    await page.keyboard.press('Escape')
  }
  await mockDo(() => { window.__sorterMock.learning = window.__sorterMock.fixtures.real; window.__sorterMock.set({ learnable: { kept: 228, binned: 84 } }) })

  // the sorter needs training (changed since it last learnt) or was never trained: the strip says so and links to Auto sorting, beating every other state
  await mockDo(() => window.__sorterMock.preset('needsTraining'))
  await page.waitForSelector('.ts-strip[data-kind=untrained]')
  check('strip, needs training again: the sentence and the link, no retrain countdown', (await stripText()).startsWith('The sorter needs training again before it can learn from your answers.') && !(await stripText()).includes('retrains after') && (await page.locator('.ts-train-link').innerText()) === 'Train in Auto sorting →', await stripText())
  check('the "Teaches most first" switch stays', (await page.locator('.rv-teach-switch').count()) === 1)
  await shoot(page, 'fix-strip-needs-training.png')
  await mockDo(() => window.__sorterMock.set({ retraining: 'auto', waitingForPower: { answers: 10 } }))
  check('it beats retraining and waiting too', (await strip().getAttribute('data-kind')) === 'untrained')
  await mockDo(() => window.__sorterMock.preset('neverTrained'))
  await page.waitForFunction(() => document.querySelector('.ts-strip')?.textContent?.includes('has not been trained yet'))
  check('strip, never trained: "The sorter has not been trained yet." with the link', (await stripText()).startsWith('The sorter has not been trained yet.') && (await page.locator('.ts-train-link').count()) === 1)
  // the round opened in this state says the same, with the same link, and focus is inside it
  await mockDo(() => window.__sorterMock.preset('needsTraining'))
  await page.waitForSelector('.ts-strip[data-kind=untrained]')
  await page.locator('.ts-enough').click()
  await page.waitForSelector('.tr-popover .sr-teach')
  check('popover while the sorter needs training: says the reading is from the last training', (await page.locator('.tr-popover .sr-from-last').innerText()) === 'From the last training, before the sorter changed.')
  await page.locator('.tr-popover .sr-teach').click()
  await page.waitForSelector('[data-testid=round-untrained]')
  const ru = (await page.locator('[data-testid=round-untrained]').innerText()).replace(/\s+/g, ' ')
  check('round in this state: the same sentence and link, not "nothing unsure"', ru.includes('The sorter needs training again before it can learn from your answers.') && ru.includes('Train in Auto sorting →') && !ru.includes('nothing unsure'), ru)
  check('round: focus is inside the dialog on open', await page.evaluate(() => !!document.activeElement?.closest('.tr-round')))
  check('the popover the round was opened from is closed under it', (await page.locator('.tr-popover').count()) === 0)
  await shoot(page, 'fix-round-needs-training.png')
  await page.keyboard.press('Escape')
  check('Esc closes the round while the sorter needs training', (await page.locator('.tr-round').count()) === 0)
  await page.locator('.ts-enough').click()
  await page.locator('.tr-popover .sr-teach').click()
  await page.waitForSelector('[data-testid=round-untrained]')
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))
  await page.keyboard.press('Escape')
  check('Esc closes it with the focus outside the dialog too', (await page.locator('.tr-round').count()) === 0)
  await page.locator('.ts-enough').click()
  await page.locator('.tr-popover .sr-teach').click()
  await page.waitForSelector('[data-testid=round-untrained]')
  await page.locator('.tr-train-link').click()
  await page.waitForSelector('.as-tab')
  check('the round link goes to Triage › Auto sorting and closes the round', (await page.locator('.triage-controls .scope-tab.active', { hasText: 'Auto sorting' }).count()) === 1 && (await page.locator('.tr-round').count()) === 0)
  await page.waitForSelector('.as-training .lc-svg')
  await page.locator('.as-training').scrollIntoViewIfNeeded()
  check('Auto sorting, needs training: the Training area has both switches and the line, and the reading from the last training', (await page.locator('.as-training .as-auto-retrain').count()) === 1 && (await page.locator('.as-training .as-starts-once').innerText()) === 'Starts once the sorter has been trained.' && (await page.locator('.as-training .sr-from-last').count()) === 1 && (await page.locator('.as-training .as-bar').count()) === 0, await page.locator('.as-training').innerText())
  await page.locator('.view-switch .scope-tab', { hasText: 'Review' }).click()
  await page.waitForSelector('.rv-big')
  await page.waitForSelector('.ts-strip[data-kind=untrained]')
  await page.locator('.ts-train-link').click()
  await page.waitForSelector('.as-tab')
  check('the strip link goes to Triage › Auto sorting', (await page.locator('.triage-controls .scope-tab.active', { hasText: 'Auto sorting' }).count()) === 1)
  await page.locator('.view-switch .scope-tab', { hasText: 'Review' }).click()
  await page.waitForSelector('.rv-big')
  await mockDo(() => window.__sorterMock.preset('counting'))
  await page.waitForSelector('.ts-strip[data-kind=counting]')
  await mockDo(() => { window.__sorterMock.learning = window.__sorterMock.fixtures.real })

  await mockDo(() => { window.__sorterMock.learning = { ...window.__sorterMock.learning, verdict: 'not-enough', more: 52, choices: 40, kept: 30, thrownAway: 10, points: [] } })
  await page.locator('.ts-enough').click()
  await page.waitForFunction(() => document.querySelector('.sr-headline')?.textContent?.includes('needs 52 more'))
  check('not enough choices yet: how many more, and the minimum, no chart', (await page.locator('.sr-sub').innerText()).includes('92 choices, 46 kept and 46 thrown away') && (await page.locator('.lc-svg').count()) === 0)
  await page.locator('.tr-popover-foot').click()
  await page.waitForSelector('.as-tab')
  check('"Open in Auto sorting" goes to Triage › Auto sorting', (await page.locator('.triage-controls .scope-tab.active', { hasText: 'Auto sorting' }).count()) === 1 && (await page.locator('.tr-popover').count()) === 0)
  await page.locator('.view-switch .scope-tab', { hasText: 'Review' }).click()
  await page.waitForSelector('.rv-big')
  // Esc closes the round opened from the popover in the asking state as well, and answers nothing
  await page.locator('.ts-enough').click()
  await page.waitForSelector('.tr-popover .sr-teach')
  const needBeforeRound = (await page.evaluate(() => window.sw.review.overview())).needALook
  await page.locator('.tr-popover .sr-teach').click()
  await page.waitForSelector('.tr-round[data-phase=asking]')
  await page.keyboard.press('Escape')
  check('Esc closes the round while asking, opened from the popover, and writes nothing', (await page.locator('.tr-round').count()) === 0 && (await page.locator('.tr-popover').count()) === 0 && (await page.evaluate(() => window.sw.review.overview())).needALook === needBeforeRound, `${await page.locator('.tr-round').count()} ${await page.locator('.tr-popover').count()} ${(await page.evaluate(() => window.sw.review.overview())).needALook} ${needBeforeRound}`)
  check('no page errors', errors.length === 0, errors.join(' | '))

  // Review moves to the right next card, with its picture, in both orders (the stuck-picture defect): every screenshot has a
  // picture except the first, whose picture does not load. Keep, throwaway, skip and ⌘Z each land on the right card, and the
  // title, "Question 1 of N" and "Up next · 2–6 of N" agree after every step.
  for (const order of ['teach', 'newest']) {
    const tp = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    tp.on('pageerror', (e) => errors.push(e.message))
    await tp.goto(`${url}?reviewThumbs=1`)
    await tp.locator('.view-switch .scope-tab', { hasText: 'Review' }).click()
    await tp.waitForSelector('.rv-big')
    if (order === 'newest') {
      await tp.locator('.rv-teach-switch').click()
      await tp.waitForTimeout(150)
    }
    const cur = () => tp.locator('.rv-big').getAttribute('data-hash')
    const press = async (k) => {
      await tp.keyboard.press(k)
      await tp.waitForTimeout(200)
    }
    const bigPicture = () => tp.locator('.rv-big .rv-shot img').evaluateAll((els) => els.map((e) => e.complete && e.naturalWidth > 0))
    const agree = async () => {
      const h = Number((await tp.locator('.rv-head h1').innerText()).match(/^(\d+) need a look/)?.[1])
      const q = Number((await tp.locator('.rv-cert-note').innerText()).match(/Question 1 of (\d+)/)?.[1])
      const u = (await tp.locator('.rv-next h3').innerText()).match(/^Up next · 2–(\d+) of (\d+)/i)
      const live = (await tp.evaluate(() => window.sw.review.overview())).needALook
      return h === live && q === live && u !== null && Number(u[2]) === live && Number(u[1]) === Math.min(6, live) ? live : `title ${h}, question of ${q}, up next ${u?.[0]}, live ${live}`
    }
    const q = (await tp.evaluate((o) => window.sw.review.overview({ order: o }), order)).queue.map((c) => c.hash)
    const n0 = q.length
    check(`${order}: the first card is first in the queue, its picture failed to load and shows the placeholder`, (await cur()) === q[0] && (await tp.locator('.rv-big .rv-shot img').count()) === 0 && (await tp.locator('.rv-big .rv-shot[data-picture=missing]').count()) === 1)
    check(`${order}: Up next shows items 2 to 6 with their pictures`, JSON.stringify(await tp.locator('.rv-up').evaluateAll((els) => els.map((e) => e.getAttribute('data-hash')))) === JSON.stringify(q.slice(1, 6)) && (await tp.locator('.rv-up .rv-shot img').count()) === 5)
    check(`${order}: title, "Question 1 of N" and "Up next · 2–6 of N" agree`, (await agree()) === n0, String(await agree()))
    await press('k')
    check(`${order}: K moves to item 2 of Up next, which shows its picture (one failed picture does not stick)`, (await cur()) === q[1] && JSON.stringify(await bigPicture()) === '[true]', `${await cur()} ${JSON.stringify(await bigPicture())}`)
    check(`${order}: one answer, one decision: the count drops by one and the card is kept by you`, (await agree()) === n0 - 1 && (await tp.evaluate((h) => window.sw.review.cards([h]), q[0]))[0]?.pile === 'kept', String(await agree()))
    await press('t')
    check(`${order}: T moves to the next card, with its picture`, (await cur()) === q[2] && JSON.stringify(await bigPicture()) === '[true]' && (await agree()) === n0 - 2 && (await tp.evaluate((h) => window.sw.review.cards([h]), q[1]))[0]?.pile === 'throwaway')
    const shown = await tp.evaluate(() => window.__reviewShown ?? [])
    check(`${order}: each answer sends the picture as shown: missing for the one that would not load, ok for a real picture`, JSON.stringify(shown.slice(-2)) === JSON.stringify([[q[0], 'missing'], [q[1], 'ok']]), JSON.stringify(shown))
    await press('ArrowDown')
    check(`${order}: ↓ skips to the next card and writes nothing`, (await cur()) === q[3] && (await agree()) === n0 - 2 && JSON.stringify(await bigPicture()) === '[true]')
    await press('Meta+z')
    check(`${order}: ⌘Z brings back the card thrown away last`, (await cur()) === q[1] && (await agree()) === n0 - 1)
    await press('Meta+z')
    check(`${order}: ⌘Z again brings back the kept one, its picture still the placeholder`, (await cur()) === q[0] && (await agree()) === n0 && (await tp.locator('.rv-big .rv-shot img').count()) === 0)
    // an answer that is written but answered with an error still moves on: the queue is read again either way
    await tp.evaluate(() => {
      const orig = window.sw.review.act
      window.sw.review.act = async (...a) => {
        await orig(...a)
        window.sw.review.act = orig
        throw new Error('reply lost')
      }
    })
    await press('k')
    check(`${order}: an answer whose reply is lost still moves to the next card`, (await cur()) !== q[0] && (await agree()) === n0 - 1 && (await tp.evaluate((h) => window.sw.review.cards([h]), q[0]))[0]?.pile === 'kept', String(await agree()))
    if (order === 'teach') await shoot(tp, 'fix-review-next-card-picture.png')
    await tp.close()
  }
  // a picture that is not there says why, in a flat panel that does not look like a screenshot (m001 not found, m002 not downloaded, m003 no picture)
  {
    const pp = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    pp.on('pageerror', (e) => errors.push(e.message))
    await pp.goto(`${url}?reviewThumbs=1&reviewPictures=1`)
    await pp.locator('.view-switch .scope-tab', { hasText: 'Review' }).click()
    await pp.waitForSelector('.rv-big')
    const big = () => pp.locator('.rv-big .rv-shot').innerText()
    const upText = (h) => pp.locator(`.rv-up[data-hash=${h}] .rv-shot`).innerText()
    const first = await pp.locator('.rv-big').getAttribute('data-hash')
    const bigNow = await big()
    check('no picture: the big card for a file that is gone says "File not found" and where it was expected (home shown as ~ in display only)', first === 'm001' && bigNow.includes('File not found') && bigNow.includes('Expected in /Volumes/example/Screenshots/2026-10'), `${first} ${bigNow}`)
    check('no picture: Up next shows a small label per state and a real picture for the rest', (await upText('m002')) === 'Not downloaded' && (await upText('m003')) === 'No picture' && (await pp.locator('.rv-up[data-hash=m005] .rv-shot img').count()) === 1)
    await pp.keyboard.press('k')
    await pp.waitForTimeout(250)
    const b2 = await big()
    check('no picture: the big card for a cloud placeholder says so, explains, and offers Open in Finder', (await pp.locator('.rv-big').getAttribute('data-hash')) === 'm002' && b2.includes('Not downloaded on this Mac') && b2.includes('open it in Finder to download it') && (await pp.getByRole('button', { name: 'Open in Finder' }).count()) === 1, b2)
    check('no picture: the panel is flat and dashed, with no lines, no window shape and no gradient', await pp.locator('.rv-big .rv-shot').evaluate((el) => { const c = getComputedStyle(el); return c.borderStyle === 'dashed' && c.backgroundImage === 'none' && el.querySelectorAll('img, svg, canvas').length === 0 }))
    await pp.keyboard.press('ArrowDown')
    await pp.keyboard.press('ArrowDown')
    await pp.waitForTimeout(250)
    check('no picture: a card without a record says "No picture" and can still be answered', (await pp.locator('.rv-big').getAttribute('data-hash')) === 'm003' && (await big()).includes('No picture') && (await pp.locator('.rv-big .rv-shot').evaluate((el) => !el.querySelector('img'))))
    await pp.locator('.rv-pile-btn').click()
    await pp.waitForTimeout(300)
    check('the old drawn window is gone everywhere', (await pp.locator('.rv-win').count()) === 0)
    await pp.close()
  }
  check('no page errors in the next-card pass', errors.length === 0, errors.join(' | '))

  // the "How sure" filter: a range in 5% steps, obeyed in the queue, the counts and both piles
  const sp = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  sp.on('pageerror', (e) => errors.push(e.message))
  await sp.goto(url)
  await sp.locator('.view-switch .scope-tab', { hasText: 'Review' }).click()
  await sp.waitForSelector('.rv-big')
  const sh1 = () => sp.locator('.rv-head h1').innerText()
  const scur = () => sp.locator('.rv-big').getAttribute('data-hash')
  const range = { min: 0.55, max: 0.65 }
  const wantQ = (await sp.evaluate((sure) => window.sw.review.overview({ queue: 50, order: 'teach', sure }), range)).queue.map((c) => c.hash)
  const allOv = await sp.evaluate(() => window.sw.review.overview())
  check('How sure button reads "all" when nothing is set', (await sp.locator('.rv-sure-btn').first().innerText()) === 'How sure: all')
  await sp.locator('.rv-sure-btn').first().click()
  check('the popover has From and To, keyboard operable, in 5% steps', (await sp.getByRole('slider', { name: 'From' }).getAttribute('step')) === '5' && (await sp.getByRole('slider', { name: 'To' }).getAttribute('max')) === '100')
  await sp.getByRole('slider', { name: 'From' }).fill('55')
  await sp.getByRole('slider', { name: 'To' }).fill('65')
  await sp.waitForTimeout(300) // the two range loads (55–100, then 55–65) settle before the counts are read
  const fo = await sp.evaluate((sure) => window.sw.review.overview({ sure }), range)
  check('the button shows the range', (await sp.locator('.rv-sure-btn').first().innerText()) === 'How sure: 55–65%')
  check('the title count is filtered and says so', (await sh1()) === `${fo.needALook} need a look · how sure 55–65%` && fo.needALook === wantQ.length && wantQ.length > 0 && wantQ.length < allOv.needALook, await sh1())
  check('the live count line', (await sp.getByTestId('sure-count').innerText()) === `${fo.needALook} of ${allOv.needALook} need a look, ${fo.confident.kept + fo.confident.throwaway} of ${allOv.confident.kept + allOv.confident.throwaway} sorted confidently`, await sp.getByTestId('sure-count').innerText())
  await sp.keyboard.press('Escape')
  check('Escape closes the popover and focus returns to the button', (await sp.locator('.rv-sure-pop').count()) === 0 && (await sp.evaluate(() => document.activeElement?.classList.contains('rv-sure-btn'))) && (await sh1()).includes('how sure 55–65%'))
  await sp.locator('.rv-sure-btn').first().click()
  await sp.locator('.rv-head h1').click()
  check('clicking outside closes it', (await sp.locator('.rv-sure-pop').count()) === 0)
  check('the current card is the first filtered card', (await scur()) === wantQ[0], `${await scur()} vs ${wantQ}`)
  check('up next lists the next filtered cards, and "Question 1 of N" agrees', (await sp.locator('.rv-up').evaluateAll((els) => els.map((e) => e.getAttribute('data-hash')))).join() === wantQ.slice(1, 6).join() && (await sp.locator('.rv-cert-note').innerText()).includes(`Question 1 of ${wantQ.length}`))
  check('every card shown has a "sure" inside the range', await sp.evaluate(async (hs) => (await window.sw.review.cards(hs)).every((c) => { const k = Math.round(c.pKeep * 100); const s = c.pKeep >= 0.5 ? k : 100 - k; return s >= 55 && s <= 65 }), wantQ))
  check('the Review tab count stays unfiltered', (await sp.locator('.view-switch .rv-tab-n').innerText()) === String(allOv.needALook))
  await sp.keyboard.press('k')
  await sp.waitForTimeout(150)
  check('answering under the filter brings up the next filtered card', (await scur()) === wantQ[1] && (await sh1()) === `${wantQ.length - 1} need a look · how sure 55–65%`, await sh1())
  await sp.keyboard.press('Meta+z')
  await sp.waitForTimeout(150)
  check('undo under the filter brings the card back', (await scur()) === wantQ[0] && (await sh1()).startsWith(`${wantQ.length} need a look`))
  await sp.locator('.rv-pile-btn').click()
  await sp.waitForSelector('.rv-pl-left')
  const fp = await sp.evaluate((sure) => window.sw.review.piles({ sure }), { min: 0.9, max: 0.95 })
  await sp.locator('.rv-sure-btn').click()
  await sp.getByRole('slider', { name: 'From' }).fill('90')
  await sp.getByRole('slider', { name: 'To' }).fill('95')
  await sp.keyboard.press('Escape')
  await sp.waitForTimeout(200)
  check('both piles obey it (inclusive at 95)', (await sp.locator('.rv-pgrid .rv-pc').count()) === fp.kept.total && fp.kept.total > 0 && fp.throwaway.total > 0 && (await sp.locator('.rv-pl-right .rv-tr').count()) === Math.min(60, fp.throwaway.total) && (await sp.locator('.rv-pl-left .rv-count').innerText()).startsWith(`${fp.kept.total} `))
  check('Empty Bin is held back while a range is set', await sp.evaluate(() => !document.querySelector('.rv-empty-btn') || document.querySelector('.rv-empty-btn').disabled))
  await sp.locator('.rv-back-btn').click()
  await sp.waitForSelector('.rv-big')
  await sp.locator('.rv-sure-btn').first().click()
  await sp.getByRole('slider', { name: 'From' }).fill('50')
  await sp.getByRole('slider', { name: 'To' }).fill('50')
  await sp.keyboard.press('Escape')
  await sp.waitForSelector('[data-testid="sure-empty"]')
  check('an empty range says so, with Show all', (await sp.locator('[data-testid="sure-empty"] h2').innerText()) === 'Nothing in Review is between 50% and 50% sure.' && (await sh1()).startsWith('0 need a look'))
  await shoot(sp, 'review-ui-sure-empty.png')
  await sp.locator('[data-testid="sure-empty"] button', { hasText: 'Show all' }).click()
  await sp.waitForSelector('.rv-big[data-hash]')
  check('Show all restores everything', (await sh1()) === `${allOv.needALook} need a look` && (await sp.locator('.rv-sure-btn').first().innerText()) === 'How sure: all')
  // only the sorted-confidently pile matches a range: the heading says nothing that needs a look is there, and the line points to the strip
  const onlyConfident = await sp.evaluate(async () => {
    const steps = [50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100]
    for (const a of steps) for (const b of steps) {
      if (b < a || (a === 50 && b === 100)) continue
      const o = await window.sw.review.overview({ queue: 50, sure: { min: a / 100, max: b / 100 } })
      if (o.needALook === 0 && o.confident.kept + o.confident.throwaway > 0) return { a, b }
    }
    return null
  })
  check('the mock has a range that holds only confident items', onlyConfident !== null, JSON.stringify(onlyConfident))
  if (onlyConfident) {
    await sp.locator('.rv-sure-btn').first().click()
    await sp.getByRole('slider', { name: 'From' }).fill(String(onlyConfident.a))
    await sp.getByRole('slider', { name: 'To' }).fill(String(onlyConfident.b))
    await sp.keyboard.press('Escape')
    await sp.waitForSelector('[data-testid="sure-empty"]')
    const emptyHead = await sp.locator('[data-testid="sure-empty"] h2').innerText()
    const emptyLine = await sp.locator('[data-testid="sure-empty"] p').innerText()
    check('only the confident pile matches: the heading says nothing that needs a look is in the range, and the line points to the strip', emptyHead === `Nothing that needs a look is between ${onlyConfident.a}% and ${onlyConfident.b}% sure.` && emptyLine.includes('in the strip below'), `${emptyHead} | ${emptyLine}`)
    await sp.locator('[data-testid="sure-empty"] button', { hasText: 'Show all' }).click()
    await sp.waitForSelector('.rv-big[data-hash]')
  }
  // Show all inside the How sure popover: focus stays in the popover, so Escape closes it and does not reach the page
  await sp.locator('.rv-sure-btn').first().click()
  await sp.getByRole('slider', { name: 'From' }).fill('55')
  await sp.getByRole('slider', { name: 'To' }).fill('65')
  await sp.locator('.rv-sure-all').click()
  check('after Show all in the popover, focus is on the From slider', await sp.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'From'))
  await sp.keyboard.press('Escape')
  check('Escape after Show all closes the popover and stays on Review', (await sp.locator('.rv-sure-pop').count()) === 0 && (await sh1()).endsWith('need a look') && (await sp.locator('.rv-big').count()) === 1)
  check('no page errors in the how-sure pass', errors.length === 0, errors.join(' | '))
  await sp.close()

  // a Keep still pending when the range changes: the refresh after it must show the range the control shows, not the whole queue
  const kp = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  kp.on('pageerror', (e) => errors.push(e.message))
  await kp.goto(url)
  await kp.locator('.view-switch .scope-tab', { hasText: 'Review' }).click()
  await kp.waitForSelector('.rv-big')
  await kp.evaluate(() => { window.__reviewMockDelay = (sure) => (sure ? 0 : 700) }) // an unfiltered answer is held 700 ms; filtered ones are at once
  await kp.keyboard.press('k') // Keep, with no filter
  await kp.waitForTimeout(100)
  await kp.locator('.rv-sure-btn').first().click()
  await kp.getByRole('slider', { name: 'From' }).fill('90')
  await kp.keyboard.press('Escape')
  await kp.waitForTimeout(1500)
  const keptRange = await kp.evaluate(() => window.sw.review.overview({ queue: 50, sure: { min: 0.9, max: 1 } }))
  check('Keep finishes after the range is set to 90–100%: the list stays on 90–100%', (await kp.locator('.rv-head h1').innerText()) === `${keptRange.needALook} need a look · how sure 90–100%` && (await kp.locator('.rv-sure-btn').first().innerText()) === 'How sure: 90–100%', `${await kp.locator('.rv-head h1').innerText()} (expected ${keptRange.needALook} under 90–100%)`)
  await kp.evaluate(() => { window.__reviewMockDelay = undefined })
  check('no page errors in the pending-answer pass', errors.length === 0, errors.join(' | '))
  await kp.close()

  // a Bin split by a range (8 in all; 5 of them 94% sure): late answers never overwrite newer ones, and Empty Bin is only
  // offered once the whole, unfiltered Bin is on screen, with that answer's count and token
  const bp = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  bp.on('pageerror', (e) => errors.push(e.message))
  await bp.goto(`${url}?reviewBin=6`)
  await bp.locator('.view-switch .scope-tab', { hasText: 'Review' }).click()
  await bp.locator('.rv-pile-btn').click()
  await bp.waitForSelector('.rv-pl-left')
  await bp.locator('.rv-bin-row .rv-link').click()
  const wholeBin = (await bp.evaluate(() => window.sw.review.piles())).bin.total
  const binRows = () => bp.locator('.rv-pl-right .rv-tr').count()
  const emptyOff = () => bp.evaluate(() => document.querySelector('.rv-empty-btn')?.disabled ?? true)
  const bh1 = () => bp.locator('.rv-head h1').innerText()
  await bp.locator('.rv-sure-btn').click()
  await bp.getByRole('slider', { name: 'From' }).fill('90')
  await bp.getByRole('slider', { name: 'To' }).fill('95')
  await bp.waitForTimeout(200)
  check('a range splits the Bin, and Empty Bin is held back', wholeBin === 8 && (await binRows()) === 5 && (await emptyOff()), `${wholeBin} / ${await binRows()}`)
  // Show all while every answer is slow: the filtered Bin is still on screen, so Empty Bin must stay off until the whole Bin arrives
  await bp.evaluate(() => { window.__reviewMockDelay = () => 700 })
  await bp.locator('.rv-sure-all').click()
  await bp.waitForTimeout(100)
  check('Show all does not offer Empty Bin before the whole Bin is on screen', await emptyOff())
  await bp.waitForTimeout(1500)
  check('once the whole Bin arrives, Empty Bin is offered', (await binRows()) === wholeBin && !(await emptyOff()), `${await binRows()}`)
  // a filtered read that answers after Show all is dropped, not shown under "Both piles"
  await bp.evaluate(() => { window.__reviewMockDelay = (sure) => (sure ? 900 : 0) })
  await bp.getByRole('slider', { name: 'From' }).fill('90')
  await bp.waitForTimeout(50)
  await bp.locator('.rv-sure-all').click()
  await bp.waitForTimeout(2200)
  check('a late filtered answer never overwrites the newer unfiltered one', (await bh1()) === 'Both piles' && (await binRows()) === wholeBin && !(await emptyOff()), `${await bh1()} / ${await binRows()}`)
  await bp.evaluate(() => { window.__reviewMockDelay = undefined })
  await bp.locator('.rv-head h1').click() // close the popover by clicking outside (Show all has disabled itself, so focus is not in it)
  await bp.locator('.rv-empty-btn').click()
  check('the confirm names the whole Bin', (await bp.locator('.rv-confirm h3').innerText()) === `Hide ${wholeBin} screenshots for good?`)
  await bp.locator('.rv-danger').click()
  await bp.waitForTimeout(300)
  check('Empty Bin hid exactly the count the confirm named', (await bp.evaluate(() => window.sw.review.piles())).bin.total === 0)
  check('no page errors in the Bin-and-range pass', errors.length === 0, errors.join(' | '))
  await bp.close()

  // answers given on cards that had no picture (ReviewBlind.tsx, main review/rescue.ts): banner, confirm, Not now, put back
  const bl = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  bl.on('pageerror', (e) => errors.push(e.message))
  await bl.goto(`${url}?reviewBlind=1`)
  await bl.locator('.view-switch .scope-tab', { hasText: 'Review' }).click()
  await bl.waitForSelector('[data-testid=blind-banner]')
  check('the banner names the blind answers: all of them, thrown away and kept',
    (await bl.locator('[data-testid=blind-banner] .rv-blind-text').innerText()) === '6 answers may have been given without a picture (3 thrown away, 3 kept). Put them back to undecided and retrain?',
    await bl.locator('[data-testid=blind-banner] .rv-blind-text').innerText())
  check('the banner sits under the sorter strip', await bl.evaluate(() => document.querySelector('.ts-strip')?.nextElementSibling?.classList.contains('rv-blind') === true))
  await bl.locator('.rv-blind-go').click()
  const blindConfirm = await bl.locator('.rv-confirm').innerText()
  check('the confirm says exactly what will happen',
    blindConfirm.includes('Put 5 answers back to undecided?') &&
    blindConfirm.includes('3 thrown away and 2 kept go back to undecided.') &&
    blindConfirm.includes('1 kept one already imported stays kept.') &&
    blindConfirm.includes('No files are moved or deleted. The sorter then retrains.') &&
    blindConfirm.includes('6 answers may have been given without a picture (3 thrown away, 3 kept).'), blindConfirm)
  // the list: every one put back, with its file name, his answer and why there was no picture, from the same read as the counts
  const listed = await bl.evaluate(() => [...document.querySelectorAll('[data-testid=blind-list] .rv-blind-item')].map((li) => [...li.children].map((c) => c.textContent)))
  const fromMain = await bl.evaluate(() => window.sw.review.blindAnswers())
  const want = fromMain.items.filter((i) => i.putBack).map((i) => [i.filename, i.answer === 'throwaway' ? 'thrown away' : 'kept', `${{ 'not-downloaded': 'not downloaded', missing: 'not found', none: 'no picture' }[i.picture]} ${i.recorded ? 'when you answered' : 'now'}`])
  check('the confirm lists every one put back: file name, answer, picture state', listed.length === 5 && JSON.stringify(listed) === JSON.stringify(want), JSON.stringify(listed))
  check('the list names all three picture states, recorded ones "when you answered" and older ones "now"', ['not found', 'not downloaded', 'no picture'].every((w) => listed.some((r) => r[2].startsWith(w))) && listed.some((r) => r[2] === 'not found when you answered') && listed.some((r) => r[2].endsWith(' now')), JSON.stringify(listed))
  check('the list scrolls rather than growing the dialog', await bl.evaluate(() => { const l = getComputedStyle(document.querySelector('[data-testid=blind-list]')); return l.overflowY === 'auto' && l.maxHeight !== 'none' }))
  const queueBefore = await bl.locator('.rv-big').getAttribute('data-hash')
  await bl.keyboard.press('k')
  await bl.waitForTimeout(150)
  check('Review keys do nothing while the confirm is open', (await bl.locator('.rv-big').getAttribute('data-hash')) === queueBefore && (await bl.locator('.rv-confirm').count()) === 1)
  await bl.keyboard.press('Escape')
  check('Esc closes the confirm and writes nothing', (await bl.locator('.rv-confirm').count()) === 0 && (await bl.evaluate(() => window.sw.review.blindAnswers())).thrownAway === 3)
  await bl.locator('.rv-blind-go').click()
  await bl.locator('.rv-blind-confirm').click()
  await bl.waitForSelector('[data-testid=blind-done]')
  check('after putting back: "Put back N. Retraining…"', (await bl.locator('[data-testid=blind-done]').innerText()) === 'Put back 5. Retraining…')
  check('a manual retrain was asked for', (await bl.evaluate(() => window.__sorterMock.calls.retrainNow)).includes('manual'))
  await bl.waitForSelector('[data-testid=retrain-notice]', { timeout: 5000 })
  await bl.waitForTimeout(200)
  check('then the normal retrain notice, and the banner is gone', (await bl.locator('[data-testid=blind-done]').count()) === 0 && (await bl.locator('[data-testid=blind-banner]').count()) === 0)
  const after = await bl.evaluate(() => window.sw.review.blindAnswers())
  check('only the imported keep is left; the put-back ones are undecided', after.thrownAway === 0 && after.keptNotImported === 0 && after.keptImported === 1)
  await bl.close()

  // the set changed between his look and his confirm: refused, said plainly, and the list read again
  const ch = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  ch.on('pageerror', (e) => errors.push(e.message))
  await ch.goto(`${url}?reviewBlind=1`)
  await ch.locator('.view-switch .scope-tab', { hasText: 'Review' }).click()
  await ch.waitForSelector('[data-testid=blind-banner]')
  await ch.locator('.rv-blind-go').click()
  await ch.evaluate(async () => {
    const b = await window.sw.review.blindAnswers()
    await window.sw.review.act(b.items.find((i) => i.answer === 'throwaway').hash, 'keep') // answered again elsewhere
  })
  await ch.locator('.rv-blind-confirm').click()
  await ch.waitForSelector('.rv-blind-err')
  check('a changed set is refused with "Something changed since you looked; check the list again."', (await ch.locator('.rv-blind-err').innerText()).trim() === 'Something changed since you looked; check the list again.', await ch.locator('.rv-blind-err').innerText())
  await ch.waitForTimeout(150)
  check('… and the banner shows the list as it is now', (await ch.locator('[data-testid=blind-banner] .rv-blind-text').innerText()).startsWith('5 answers may have been given') && (await ch.locator('[data-testid=blind-done]').count()) === 0, await ch.locator('[data-testid=blind-banner] .rv-blind-text').innerText())
  await ch.close()

  // the retrain after a put-back fails: the line says why and where to retrain, and does not wait for ever
  const fl = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  fl.on('pageerror', (e) => errors.push(e.message))
  await fl.goto(`${url}?reviewBlind=1`)
  await fl.locator('.view-switch .scope-tab', { hasText: 'Review' }).click()
  await fl.waitForSelector('[data-testid=blind-banner]')
  await fl.evaluate(() => {
    window.__sorterMock.retrainFails = 'download the picture search model first (Settings › Picture search)'
    window.__sorterMock.retrainMs = 50
  })
  await fl.locator('.rv-blind-go').click()
  await fl.locator('.rv-blind-confirm').click()
  await fl.waitForSelector('[data-testid=blind-done][data-failed=true]', { timeout: 5000 }).catch(() => undefined)
  const failedLine = (await fl.locator('[data-testid=blind-done]').count()) ? await fl.locator('[data-testid=blind-done]').innerText() : '(no line)'
  check('a retrain that fails after a put-back: "Put back N. Retraining did not finish: <why>. Retrain from Auto sorting."', failedLine === 'Put back 5. Retraining did not finish: download the picture search model first (Settings › Picture search). Retrain from Auto sorting.', failedLine)
  await fl.close()

  // the retrain fails before the put-back's reply arrives: the line does not stay on "Retraining…"
  const qk = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  qk.on('pageerror', (e) => errors.push(e.message))
  await qk.goto(`${url}?reviewBlind=1`)
  await qk.locator('.view-switch .scope-tab', { hasText: 'Review' }).click()
  await qk.waitForSelector('[data-testid=blind-banner]')
  await qk.evaluate(() => {
    window.__sorterMock.retrainMs = 0
    window.__sorterMock.retrainFails = 'the sorter is already running'
    const orig = window.sw.review.rescueBlind
    window.sw.review.rescueBlind = async (...a) => {
      const r = await orig(...a)
      await new Promise((res) => setTimeout(res, 300)) // the reply is late: the retrain has already finished
      return r
    }
  })
  await qk.locator('.rv-blind-go').click()
  await qk.locator('.rv-blind-confirm').click()
  await qk.waitForTimeout(1200)
  const quickLine = (await qk.locator('[data-testid=blind-done]').count()) ? await qk.locator('[data-testid=blind-done]').innerText() : '(no line)'
  check('a retrain that fails before the reply: says so, never stays on "Retraining…"', quickLine === 'Put back 5. Retraining did not finish: the sorter is already running. Retrain from Auto sorting.', quickLine)
  await qk.close()

  const nn = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  nn.on('pageerror', (e) => errors.push(e.message))
  await nn.goto(`${url}?reviewBlind=1`)
  await nn.locator('.view-switch .scope-tab', { hasText: 'Review' }).click()
  await nn.waitForSelector('[data-testid=blind-banner]')
  await nn.locator('.rv-blind-later').click()
  check('"Not now" hides the banner', (await nn.locator('[data-testid=blind-banner]').count()) === 0)
  await nn.locator('.rv-pile-btn').click()
  await nn.waitForSelector('.rv-pl-left')
  await nn.locator('.rv-back-btn').click()
  await nn.waitForSelector('.rv-big')
  await nn.waitForTimeout(200)
  check('… for the rest of the session, and nothing was written', (await nn.locator('[data-testid=blind-banner]').count()) === 0 && (await nn.evaluate(() => window.sw.review.blindAnswers())).thrownAway === 3)
  check('no page errors in the blind-answers pass', errors.length === 0, errors.join(' | '))
  await nn.close()

  // a Bin of 602: paged, no cap, and Empty Bin hides exactly what the confirm says
  const big = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  big.on('pageerror', (e) => errors.push(e.message))
  await big.goto(`${url}?reviewBin=600`)
  await big.locator('.view-switch .scope-tab', { hasText: 'Review' }).click()
  await big.locator('.rv-pile-btn').click()
  await big.waitForSelector('.rv-pl-left')
  await big.locator('.rv-bin-row .rv-link').click()
  const bigN = (await big.evaluate(() => window.sw.review.piles())).bin.total
  check('a Bin of more than 500 shows its first page', bigN === 602 && (await big.locator('.rv-tr').count()) === 60)
  for (let i = 0; i < 12 && (await big.locator('.rv-pl-right .rv-more').count()); i++) {
    await big.locator('.rv-pl-right .rv-more').click()
    await big.waitForTimeout(80)
  }
  check('"Show more" pages through every Bin item, past 500', (await big.locator('.rv-tr').count()) === 602)
  await big.locator('.rv-empty-btn').click()
  check('the confirm names the exact count', (await big.locator('.rv-confirm h3').innerText()) === 'Hide 602 screenshots for good?')
  await big.locator('.rv-danger').click()
  await big.waitForTimeout(300)
  check('Empty Bin hid all 602', (await big.evaluate(() => window.sw.review.piles())).bin.total === 0)
  check('no page errors at scale', errors.length === 0, errors.join(' | '))
} finally {
  await browser.close()
  await server.close()
}
console.log(failed ? `${failed} FAILED` : 'all passed')
process.exit(failed ? 1 : 0)
