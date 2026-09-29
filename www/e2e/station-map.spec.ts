import { test, expect, Page } from '@playwright/test'

/**
 * /stations Leaflet map (`?gl=0`, the fallback; the default GL map is
 * `station-map-gl.spec.ts`): hover/click interactions.
 *
 * Map mechanics (see `specs/unified-page-architecture.md`): no Leaflet
 * tooltips at all — a single HTML hover drawer names the hovered station;
 * the destination fan is off by default (`?fan=1` opts in) and its edges are
 * non-interactive decoration under the station dots.
 */

/** Wait until the first-month station data has rendered. */
async function waitForStations(page: Page) {
  await page.waitForSelector('.leaflet-container')
  // Station circles are rendered as SVG `<path>` elements in the `circles` pane.
  // Wait until at least one is present (indicates fetch + render done).
  await page.waitForFunction(() => {
    const paths = document.querySelectorAll('.leaflet-container path.leaflet-interactive')
    return paths.length > 50  // Thousands of stations; 50 is a conservative floor.
  }, { timeout: 15_000 })
}

/** Viewport midpoint of the largest (most-trafficked) visible station. */
async function biggestStation(page: Page): Promise<{ x: number; y: number }> {
  const coords = await page.evaluate(() => {
    // L.Circle renders to `<path>` with the SVG renderer. Pick the one with
    // the longest path `d` attribute as a proxy for radius (largest circle).
    const paths = document.querySelectorAll<SVGPathElement>('.leaflet-container path.leaflet-interactive')
    let best: SVGPathElement | null = null
    let bestLen = 0
    paths.forEach(p => {
      const len = p.getTotalLength?.() ?? 0
      if (len > bestLen) { bestLen = len; best = p }
    })
    if (!best) return null
    const b = best.getBoundingClientRect()
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
  })
  if (!coords) throw new Error('No station paths found')
  return coords
}

/**
 * Select the largest station by hovering its midpoint (`hoverToSelect` mode
 * — selection persists after the cursor moves away). Clicking would instead
 * TOGGLE the station into the multi-select set (`?sel=`), mounting the
 * rides panel over the lower map — see the "multi-select" spec below.
 */
async function selectBiggestStation(page: Page): Promise<{ x: number; y: number }> {
  const coords = await biggestStation(page)
  await page.mouse.move(coords.x, coords.y)
  // Hover-select commits after a 150 ms settle (anti-flicker debounce);
  // outwait it before the caller moves the cursor away.
  await page.waitForTimeout(300)
  return coords
}

/** Station-name text of the hover drawer, or `null` when it's hidden. */
async function hoverDrawerName(page: Page): Promise<string | null> {
  const name = page.locator('[class*="hoverDrawerName"]')
  return (await name.count()) ? await name.textContent() : null
}

const LINES = '.leaflet-pane.leaflet-lines-pane path'

test.describe('Station map — hover drawer + fan', () => {
  test('hovering a station fills the hover drawer; no map tooltips, no fan by default', async ({ page }) => {
    await page.goto('/stations?gl=0')
    await waitForStations(page)
    await selectBiggestStation(page)

    await expect.poll(() => hoverDrawerName(page)).toMatch(/\S/)
    expect(await page.locator('.leaflet-container .leaflet-tooltip').count()).toBe(0)
    expect(await page.locator(LINES).count()).toBe(0)

    // Cursor off the map → drawer hides.
    await page.mouse.move(5, 5)
    await expect.poll(() => hoverDrawerName(page)).toBe(null)
  })

  test('`?fan=1` draws non-interactive destination lines for the hover-selected station', async ({ page }) => {
    await page.goto('/stations?gl=0&fan=1')
    await waitForStations(page)
    await selectBiggestStation(page)
    await page.mouse.move(5, 5)

    await expect.poll(() => page.locator(LINES).count(), { timeout: 5000 }).toBeGreaterThan(100)
    expect(await page.locator(`${LINES}.leaflet-interactive`).count()).toBe(0)
  })
})

test.describe('Station map — multi-select rides panel', () => {
  test('clicking a station toggles it into `?sel=` and opens the rides panel', async ({ page }) => {
    await page.goto('/stations?gl=0')
    await waitForStations(page)
    const station = await biggestStation(page)
    await page.mouse.click(station.x, station.y)

    // One chip (with a remove button) + the panel's Range control appear.
    const chipX = page.getByRole('button', { name: /^Remove / })
    await expect(chipX).toHaveCount(1)
    await expect(page.getByLabel('Range:')).toBeVisible()
    // `?sel=` carries exactly the clicked station's short_name.
    const sel = new URL(page.url()).searchParams.get('sel')
    expect(sel).toMatch(/^[A-Z]*[\d.]+$/)
    expect(sel!.includes(',')).toBe(false)

    // Remove via the chip's × (the map circle may sit under the panel —
    // e.g. Red Hook stations at default view — so the chip is the reliable
    // removal affordance). Panel unmounts, `?sel=` clears.
    await chipX.click()
    await expect(chipX).toHaveCount(0)
    await expect.poll(() => new URL(page.url()).searchParams.get('sel')).toBe(null)
  })
})
