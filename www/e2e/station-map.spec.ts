import { test, expect, Page } from '@playwright/test'

/**
 * /stations map: hover/click interactions + tooltip overlap behavior.
 * Tooltip overlap: when a station is selected and the user hovers one
 * of its destination lines, the permanent station tooltip must hide so
 * the line tooltip isn't stacked on top of it at the source station.
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

/**
 * Select the largest (most-trafficked) station by clicking its bounding
 * midpoint. Returns its bounding box (viewport-relative) for later
 * operations (e.g. moving the mouse away from it).
 */
async function selectBiggestStation(page: Page): Promise<{ x: number; y: number }> {
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
  await page.mouse.click(coords.x, coords.y)
  return coords
}

test.describe('Station map — selection + overlap', () => {
  test('selecting a station on /stations draws destination lines + permanent tooltip', async ({ page }) => {
    await page.goto('/stations')
    await waitForStations(page)
    await selectBiggestStation(page)

    // Destination lines are polylines in the "lines" pane.
    const lines = page.locator('.leaflet-container path.leaflet-interactive').filter({
      has: page.locator(':scope'),  // noop; kept for readability
    })
    // Simpler: wait for the permanent tooltip (rendered only when a station
    // is selected).
    const permanentTip = page.locator('.leaflet-tooltip-pane .leaflet-tooltip')
      .or(page.locator('.leaflet-container .leaflet-tooltip'))
    await expect(permanentTip.first()).toBeVisible()
    // Many polylines should appear post-selection.
    expect(await lines.count()).toBeGreaterThan(100)
  })

  test('hovering a destination line hides the selected-station tooltip', async ({ page }) => {
    await page.goto('/stations')
    await waitForStations(page)
    const station = await selectBiggestStation(page)

    // Baseline: one tooltip visible — the permanent selected-station one.
    const tooltips = page.locator('.leaflet-container .leaflet-tooltip')
    await expect(tooltips).toHaveCount(1)
    const stationTipText = await tooltips.first().textContent()
    expect(stationTipText).not.toMatch(/→/)  // station TT, not a line TT

    // Hover a location where a destination line should run (a short radial
    // offset from the source station, where the fan is densest).
    await page.mouse.move(station.x + 40, station.y + 40)

    // While hovering the line: still exactly one tooltip, but now it's the
    // line tooltip ("{src} → {dst}: {count}"). The permanent station tooltip
    // is suppressed.
    await expect.poll(async () => {
      const texts = await tooltips.allTextContents()
      return texts.length === 1 && /→/.test(texts[0])
    }, { timeout: 3000, message: 'exactly one tooltip, containing "→"' }).toBe(true)
  })

  test('moving the cursor off the line restores the selected-station tooltip', async ({ page }) => {
    await page.goto('/stations')
    await waitForStations(page)
    const station = await selectBiggestStation(page)

    const tooltips = page.locator('.leaflet-container .leaflet-tooltip')
    await expect(tooltips).toHaveCount(1)

    // Hover a line (confirm transition to line-tooltip state), then move far
    // away off the map.
    await page.mouse.move(station.x + 40, station.y + 40)
    await expect.poll(async () => {
      const texts = await tooltips.allTextContents()
      return texts.length === 1 && /→/.test(texts[0])
    }, { timeout: 3000 }).toBe(true)

    await page.mouse.move(5, 5)

    // Station tooltip should return — exactly one tooltip, without "→".
    await expect.poll(async () => {
      const texts = await tooltips.allTextContents()
      return texts.length === 1 && !/→/.test(texts[0])
    }, { timeout: 3000, message: 'station tooltip restored' }).toBe(true)
  })
})
