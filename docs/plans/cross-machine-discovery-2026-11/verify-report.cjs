// Runs only against the generated design report. No app, corpus, server or external network.
const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');

(async () => {
  const screenshots = process.argv.includes('--screenshots');
  const scratch = path.join(__dirname, '.verification');
  const browser = await chromium.launch({ headless: true, ...(process.env.REPORT_CHROMIUM ? { executablePath: process.env.REPORT_CHROMIUM } : {}) });
  const errors = [], external = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    await context.route(/^https?:/, route => { external.push(route.request().url()); return route.abort(); });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(path.join(__dirname, 'report.html')).href);
    const a = page.locator('#direction-a'), b = page.locator('#direction-b'), c = page.locator('#direction-c');
    await a.locator('[data-reset]').click();
    await a.locator('[data-mode="meaning"]').click();
    assert.equal(await a.locator('[data-mode="meaning"]').getAttribute('aria-pressed'), 'true');
    await a.locator('[data-item]').last().click();
    await a.locator('[data-similar]').click();
    await a.locator('[data-offline]').check();
    assert.equal(await a.locator('[data-item]:visible').count(), 0);
    await a.locator('[data-reset]').click();
    await a.locator('[data-query]').fill('no matching demonstration words');
    await a.locator('[data-query]').press('Enter');
    assert.equal(await a.locator('[data-item]:visible').count(), 0);
    await a.locator('[data-reset]').click();
    await a.locator('[data-scope]').selectOption({ index: 1 });
    assert.equal(await a.locator('[data-item]:visible').count(), 0);
    await a.locator('[data-reset]').click();
    await a.locator('[data-mode="picture"]').click();
    assert.equal(await a.locator('[data-seed]').isVisible(), true);
    await a.locator('[data-reset]').click();
    await a.locator('[data-item="journey"]').click();
    assert.equal(await a.locator('[data-pin]').isEnabled(), true);
    await a.locator('[data-pin]').click();
    await page.waitForFunction(() => !document.querySelector('#direction-a [data-reuse]').disabled);
    await a.locator('[data-reuse]').click();
    await a.locator('[data-reset]').click();

    await b.locator('[data-context]').nth(1).click();
    const card = b.locator('[data-item]:visible').first();
    await card.locator('[data-materialise]').click();
    await card.locator('[data-insert]').waitFor({ state: 'visible' });
    await b.locator('[data-offline]').check();
    await card.locator('[data-insert]').click();
    assert.equal(await b.locator('[data-insertions] > *').count(), 1);
    await b.locator('[data-undo]').click();
    assert.equal(await b.locator('[data-insertions] > *').count(), 0);
    await b.locator('[data-paused]').check();
    assert.equal(await b.locator('[data-panel-state="paused"]').isVisible(), true);
    await b.locator('[data-reset]').click();

    await c.locator('[data-c-open]').first().click();
    await c.locator('[data-c-expand]').click();
    assert.equal(await c.locator('[data-c-variants]').isVisible(), true);
    await c.locator('[data-c-compare]').first().click();
    assert.equal(await c.locator('[data-c-screen="compare"]').isVisible(), true);
    await c.locator('[data-c-theme]').click();
    await c.locator('[data-c-save-open]').click();
    await c.locator('[data-c-view-name]').fill('A reusable view');
    await c.locator('[data-c-save-confirm]').click();
    assert.match(await c.locator('[data-c-saved-list]').textContent(), /A reusable view/);
    await c.locator('[data-c-pin]').click();
    await c.locator('[data-c-status-ready]').waitFor({ state: 'visible' });
    await c.locator('[data-c-offline]').check();
    assert.equal(await c.locator('[data-c-host-only]:visible').count(), 0);
    await c.locator('[data-c-reset]').click();

    for (const width of [1280, 728, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Page overflow at ' + width);
      if (screenshots) {
        await fs.mkdir(scratch, { recursive: true });
        for (const id of ['a', 'b', 'c']) await page.locator('#direction-' + id).screenshot({ path: path.join(scratch, id + '-' + width + '.png') });
      }
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log(JSON.stringify({ directions: 3, interactions: 'Words/Meaning/Picture, selection/related, empty/denied/offline, materialise/insert/undo, pause, group/variants/compare/save/pin/reset', widths: [1280, 728, 390], pageErrors: errors, externalRequests: external, screenshots }, null, 2));
    await context.close();
  } finally {
    await browser.close();
    if (!screenshots) await fs.rm(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
