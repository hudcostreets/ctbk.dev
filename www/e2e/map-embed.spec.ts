import { test, expect, type Page } from '@playwright/test'
import { latestStations, screenPos, waitForGLMap, type Station } from './glMap'

/**
 * Home-page `StationMapEmbed` (GL map, shared `lib/mapSelection` model):
 * lazy-loads on scroll, shows a caption with a `<Link to="/s/<id>">` when one
 * station is selected (a `/stations?sel=…` link for several). Clicking the
 * link navigates the parent page (not an iframe).
 */

const CENTER = { lat: 40.758, lng: -73.965 }
const ZOOM = 12

type Placed = Station & { x: number; y: number }

async function openHomeMap(page: Page) {
  await page.goto('/')
  await page.waitForSelector('.plotly')
  await page.locator('#map').scrollIntoViewIfNeeded()
  await waitForGLMap(page)
  // The map is taller than the viewport: center it, so its center is on screen.
  await page.locator('.maplibregl-map').evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await expect(page.getByText(/Citi Bike rides, /)).toHaveCount(1, { timeout: 15_000 })
  await page.waitForTimeout(500)
}

/** Busy, isolated (≥ 15px from any other) stations near the viewport center. */
async function isolatedStations(page: Page): Promise<Placed[]> {
  const all: Placed[] = []
  for (const s of await latestStations(page)) all.push({ ...s, ...(await screenPos(page, s, CENTER, ZOOM)) })
  const vp = page.viewportSize()!
  return all
    .filter((s) => s.x > 100 && s.x < vp.width - 100 && s.y > 150 && s.y < vp.height - 150)
    .filter((s) => all.every((o) => o === s || Math.hypot(o.x - s.x, o.y - s.y) >= 15))
    .sort((a, b) => b.ends - a.ends)
}

test.describe('Home map embed', () => {
  test('clicking a station fills the caption with its details link', async ({ page }) => {
    await openHomeMap(page)
    await expect(page.getByText(/Tap a station/i)).toBeVisible()

    const [a] = await isolatedStations(page)
    await page.mouse.click(a.x, a.y)

    const link = page.getByRole('link', { name: /View station details/i })
    await expect(link).toHaveAttribute('href', `/s/${a.id}`)
  })

  test('clicking the details link navigates the parent page', async ({ page }) => {
    await openHomeMap(page)
    const [a] = await isolatedStations(page)
    await page.mouse.click(a.x, a.y)

    const link = page.getByRole('link', { name: /View station details/i })
    await expect(link).toBeVisible()
    await link.click()

    await expect.poll(() => new URL(page.url()).pathname).toBe(`/s/${a.id}`)
    await page.waitForSelector('h1', { timeout: 10_000 })
  })

  test('⌘-click a second station → a compare link to `/stations?sel=`', async ({ page }) => {
    await openHomeMap(page)
    const [a, ...rest] = await isolatedStations(page)
    const b = rest.find((s) => Math.hypot(s.x - a.x, s.y - a.y) >= 40)!
    await page.mouse.click(a.x, a.y)
    await page.keyboard.down('Meta')
    await page.mouse.click(b.x, b.y)
    await page.keyboard.up('Meta')

    await expect(page.getByText('2 stations')).toHaveCount(1)
    await expect(page.getByRole('link', { name: /Compare on the stations page/ })).toHaveAttribute('href', `/stations?sel=${a.id},${b.id}`)
  })
})
