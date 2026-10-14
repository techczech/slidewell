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
    check(`${order}: the first card is first in the queue, its picture failed to load and shows the placeholder`, (await cur()) === q[0] && (await tp.locator('.rv-big .rv-shot img').count()) === 0 && (await tp.locator('.rv-big .rv-win').count()) === 1)
    check(`${order}: Up next shows items 2 to 6 with their pictures`, JSON.stringify(await tp.locator('.rv-up').evaluateAll((els) => els.map((e) => e.getAttribute('data-hash')))) === JSON.stringify(q.slice(1, 6)) && (await tp.locator('.rv-up .rv-shot img').count()) === 5)
    check(`${order}: title, "Question 1 of N" and "Up next · 2–6 of N" agree`, (await agree()) === n0, String(await agree()))
    await press('k')
    check(`${order}: K moves to item 2 of Up next, which shows its picture (one failed picture does not stick)`, (await cur()) === q[1] && JSON.stringify(await bigPicture()) === '[true]', `${await cur()} ${JSON.stringify(await bigPicture())}`)
    check(`${order}: one answer, one decision: the count drops by one and the card is kept by you`, (await agree()) === n0 - 1 && (await tp.evaluate((h) => window.sw.review.cards([h]), q[0]))[0]?.pile === 'kept', String(await agree()))
    await press('t')
    check(`${order}: T moves to the next card, with its picture`, (await cur()) === q[2] && JSON.stringify(await bigPicture()) === '[true]' && (await agree()) === n0 - 2 && (await tp.evaluate((h) => window.sw.review.cards([h]), q[1]))[0]?.pile === 'throwaway')
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
  check('no page errors in the next-card pass', errors.length === 0, errors.join(' | '))

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
