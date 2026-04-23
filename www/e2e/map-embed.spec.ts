import { test, expect, Page } from '@playwright/test'

/**
 * Home-page `StationMapEmbed`: lazy-loads on scroll, shows a caption with
 * a `<Link to="/s/<slug>">` when a station is selected. Clicking the
 * link should navigate the parent page (not an iframe).
 */

async function openHomeMap(page: Page) {
  await page.goto('/')
  await page.waitForSelector('.plotly')
  await page.locator('#map').scrollIntoViewIfNeeded()
  await page.waitForSelector('.leaflet-container', { timeout: 15_000 })
  await page.locator('.leaflet-container').scrollIntoViewIfNeeded()
  await page.waitForFunction(
    () => document.querySelectorAll('.leaflet-container path.leaflet-interactive').length > 50,
    { timeout: 15_000 },
  )
}

/** Click the biggest station whose center is within the viewport. */
async function clickInViewportStation(page: Page) {
  const coords = await page.evaluate(() => {
    const vh = window.innerHeight
    const vw = window.innerWidth
    const paths = document.querySelectorAll<SVGPathElement>('.leaflet-container path.leaflet-interactive')
    let best: SVGPathElement | null = null
    let bestLen = 0
    paths.forEach(p => {
      const b = p.getBoundingClientRect()
      const cx = b.left + b.width / 2
      const cy = b.top + b.height / 2
      if (cx < 0 || cy < 0 || cx > vw || cy > vh) return
      const len = p.getTotalLength?.() ?? 0
      if (len > bestLen) { bestLen = len; best = p }
    })
    if (!best) return null
    const b = best.getBoundingClientRect()
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
  })
  if (!coords) throw new Error('no in-viewport station path found')
  await page.mouse.click(coords.x, coords.y)
}

test.describe('Home map embed', () => {
  test('clicking a station on the home embed fills the caption with a details link', async ({ page }) => {
    await openHomeMap(page)

    // Before selection: caption shows the placeholder prompt.
    await expect(page.getByText(/Tap a station/i)).toBeVisible()

    await clickInViewportStation(page)

    const link = page.getByRole('link', { name: /View station details/i })
    await expect(link).toBeVisible()
    const href = await link.getAttribute('href')
    expect(href, 'href should point at a station detail page').toMatch(/^\/s\/[^/]+/)
  })

  test('clicking the details link navigates the parent page', async ({ page }) => {
    await openHomeMap(page)
    await clickInViewportStation(page)

    const link = page.getByRole('link', { name: /View station details/i })
    await expect(link).toBeVisible()
    await link.click()

    // URL should have switched to /s/<slug>; `<h1>` is the station name.
    await expect.poll(() => page.url()).toMatch(/\/s\/[^/]+/)
    await page.waitForSelector('h1', { timeout: 10_000 })
  })
})
