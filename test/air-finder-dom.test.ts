import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import { expect, test } from 'vitest'
import { fixtureService } from './support/finder-service'

test.skipIf(process.env.SLIDEWELL_FINDER_DOM !== '1')('Air finder browser journey through the real HTTP service', async () => {
  const host = await fixtureService()
  try {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, acceptDownloads: true })
      const errors: string[] = []
      page.on('pageerror', (err) => errors.push(err.message))
      await page.goto(host.base)
      expect(await page.locator('.workspace').evaluate((el) => getComputedStyle(el).display)).toBe('grid')
      const search = async (q: string) => {
        await page.getByRole('searchbox').fill(q)
        await page.getByRole('button', { name: 'Search', exact: true }).click()
      }
      await search('lantern')
      await page.getByRole('button', { name: /Lantern survey 1.1/ }).click()
      await page.getByRole('heading', { name: 'Lantern survey 1.1' }).waitFor()
      await page.waitForFunction(() => (document.querySelector('#preview') as HTMLImageElement).naturalWidth > 0)
      await page.getByRole('button', { name: 'More like this' }).click()
      await page.getByRole('region', { name: 'Similar results' }).getByRole('button', { name: /Lantern survey 2.1/ }).waitFor()
      await page.getByLabel('Match').selectOption('meaning')
      await search('glowing beacons')
      await page.getByRole('button', { name: /lantern photo.*Meaning/ }).click()
      const downloadButton = page.getByRole('button', { name: 'Download image' })
      const provenanceLink = page.locator('#provenance')
      const offeredDownloads: string[] = []
      page.on('download', (download) => offeredDownloads.push(download.suggestedFilename()))
      await page.route('**/api/download/*', async (route) => {
        const response = await route.fetch()
        await route.fulfill({ response, headers: { ...response.headers(), 'x-slidewell-sha256': '0'.repeat(64) } })
      }, { times: 1 })
      await downloadButton.click()
      await page.getByText('The download did not match its expected hash. Try again.').waitFor()
      await provenanceLink.waitFor({ state: 'hidden' })
      expect(await provenanceLink.getAttribute('href')).toBeNull()
      expect(offeredDownloads).toEqual([])

      const [image] = await Promise.all([
        page.waitForEvent('download'), downloadButton.click()
      ])
      const imageBytes = await readFile((await image.path())!)
      expect(imageBytes).toEqual(host.fixture.bytes)
      const [sidecar] = await Promise.all([
        page.waitForEvent('download'), page.getByRole('link', { name: 'Save provenance' }).click()
      ])
      expect(JSON.parse(await readFile((await sidecar.path())!, 'utf8'))).toMatchObject({
        libraryId: 'fixture-library', itemId: 'well:a10000000001',
        sha256: createHash('sha256').update(imageBytes).digest('hex')
      })
      await page.setViewportSize({ width: 390, height: 700 })
      const layout = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        overflow: [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
          .slice(0, 10).map((el) => el.id || el.getAttribute('class') || el.tagName)
      }))
      expect(layout).toEqual({ width: 390, overflow: [] })
      host.setModelReady(false)
      await search('lantern')
      await page.getByRole('button', { name: /Lantern survey 1.1/ }).click()
      expect(await page.getByLabel('Match').isVisible()).toBe(false)
      expect(await page.getByRole('button', { name: 'More like this' }).isVisible()).toBe(false)
      expect(await page.getByRole('region', { name: 'Similar results' }).isVisible()).toBe(false)
      expect(await page.getByRole('searchbox').getAttribute('placeholder')).toBe('Words you remember')
      host.setModelReady(true)
      await search('lantern')
      await page.getByRole('button', { name: /Lantern survey 1.1/ }).click()
      expect(await page.getByLabel('Match').isVisible()).toBe(true)
      expect(await page.getByRole('button', { name: 'More like this' }).isVisible()).toBe(true)
      await search('asteroid')
      await page.getByText('No matches in the available library.').waitFor()
      await page.context().setOffline(true)
      await search('lantern')
      await page.getByText('The host is offline or the connection was lost.', { exact: false }).waitFor()
      expect(errors).toEqual([])
    } finally {
      await browser.close()
    }
  } finally {
    await host.close()
  }
}, 60_000)
