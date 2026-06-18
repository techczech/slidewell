// Runtime smoke test: launch, confirm the shell renders + archive detection runs, then
// run a real search and assert results come back from the archive.
// Run: `node e2e/smoke.mjs` (after `npm run build`), or `npm run test:smoke`.
import { _electron as electron } from 'playwright'

const out = (o) => console.log(JSON.stringify(o))

const app = await electron.launch({ args: ['.'] })
try {
  const win = await app.firstWindow({ timeout: 20000 })
  await win.waitForLoadState('domcontentloaded')

  const title = await win.title()
  const wordmark = (await win.locator('.wordmark').textContent())?.trim()
  const scopeTabs = await win.locator('.scope-tab').allTextContents()

  // status pill settles after async settings.getPaths()
  await win.waitForTimeout(600)
  const status = (await win.locator('.statusbar').first().textContent())?.replace(/\s+/g, ' ').trim()
  const archiveConnected = /archive connected/.test(status ?? '')

  // Run a real search. Only assert result content when the archive is actually present.
  let searchPass = true
  let cardCount = 0
  let firstTitle = ''
  if (archiveConnected) {
    await win.fill('.search-input', 'dyslexia')
    try {
      await win.waitForSelector('.grid .card', { timeout: 15000 })
      cardCount = await win.locator('.grid .card').count()
      firstTitle = ((await win.locator('.card-title').first().textContent()) ?? '').trim()
    } catch {
      // no cards appeared
    }
    searchPass = cardCount > 0
  }

  const shellPass = title === 'SlideWell' && wordmark === 'SlideWell' && scopeTabs.length === 3
  const pass = shellPass && searchPass
  out({ launched: true, title, wordmark, scopeTabs, archiveConnected, cardCount, firstTitle, shellPass, searchPass, pass })
  await app.close()
  process.exit(pass ? 0 : 2)
} catch (e) {
  out({ launched: false, error: String(e) })
  await app.close().catch(() => {})
  process.exit(1)
}
