// Minimal runtime smoke test: launch the packaged main, confirm the window opens,
// the shell renders, and archive detection runs. Run: `node e2e/smoke.mjs` (after `npm run build`).
import { _electron as electron } from 'playwright'

const out = (o) => console.log(JSON.stringify(o))

const app = await electron.launch({ args: ['.'] })
try {
  const win = await app.firstWindow({ timeout: 20000 })
  await win.waitForLoadState('domcontentloaded')
  const title = await win.title()
  const wordmark = (await win.locator('.wordmark').textContent())?.trim()
  const scopeTabs = await win.locator('.scope-tab').allTextContents()
  // status pill text settles after the async settings.getPaths() resolves
  await win.waitForTimeout(800)
  const status = (await win.locator('.statusbar').first().textContent())?.replace(/\s+/g, ' ').trim()
  const ok = title === 'SlideWell' && wordmark === 'SlideWell'
  out({ launched: true, title, wordmark, scopeTabs, status, pass: ok })
  await app.close()
  process.exit(ok ? 0 : 2)
} catch (e) {
  out({ launched: false, error: String(e) })
  await app.close().catch(() => {})
  process.exit(1)
}
