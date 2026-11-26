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
      const [image] = await Promise.all([
        page.waitForEvent('download'), page.getByRole('button', { name: 'Download image' }).click()
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
      await page.getByLabel('Match').selectOption('words')
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
