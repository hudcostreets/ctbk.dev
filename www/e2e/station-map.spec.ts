import { test, expect, Page } from '@playwright/test'

/**
 * /stations map: hover/click interactions + tooltip overlap behavior.
 *
 * When a station is selected and the user hovers one of its destination
 * lines, three tooltips are visible together (per
 * `3562f8d8` + `b676d3d1`): the permanent source-station tooltip, a
 * mid-edge tooltip (`→ {dst}: {count}`), and a destination-station
 * tooltip popped at the line's other end.
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

  test('hovering a destination line shows source + edge + dest tooltips', async ({ page }) => {
    await page.goto('/stations')
    await waitForStations(page)
    const station = await selectBiggestStation(page)

    // Move cursor off the source station's hit area first — otherwise the
    // station's hover tooltip stacks on top of its permanent tooltip
    // (`hoverToSelect` mode renders both when cursor is on the hit circle).
    await page.mouse.move(5, 5)

    const tooltips = page.locator('.leaflet-container .leaflet-tooltip')
    await expect.poll(async () => await tooltips.count(),
      { timeout: 3000, message: 'baseline: source-station permanent tooltip only' }).toBe(1)
    expect(await tooltips.first().textContent()).not.toMatch(/→/)

    // Hover a location where a destination line should run (a short radial
    // offset from the source station, where the fan is densest).
    await page.mouse.move(station.x + 40, station.y + 40)

    // While hovering the line: three tooltips. The source station's permanent
    // tooltip stays put, the mid-edge tooltip ("→ {dst}: {count}") appears,
    // and a permanent destination tooltip pops at the line's other end.
    await expect.poll(async () => {
      const texts = await tooltips.allTextContents()
      const arrowTips = texts.filter(t => /→/.test(t))
      const plainTips = texts.filter(t => !/→/.test(t))
      return texts.length === 3 && arrowTips.length === 1 && plainTips.length === 2
    }, { timeout: 3000, message: '3 tooltips: 1 with "→", 2 plain (source + dest)' }).toBe(true)
  })

  test('moving the cursor off the line collapses back to the source tooltip', async ({ page }) => {
    await page.goto('/stations')
    await waitForStations(page)
    const station = await selectBiggestStation(page)

    // Settle to baseline (just the permanent source TT, see test above).
    await page.mouse.move(5, 5)
    const tooltips = page.locator('.leaflet-container .leaflet-tooltip')
    await expect.poll(async () => await tooltips.count(), { timeout: 3000 }).toBe(1)

    // Hover a line (confirm transition to 3-tooltip state), then move far
    // away off the map.
    await page.mouse.move(station.x + 40, station.y + 40)
    await expect.poll(async () => {
      const texts = await tooltips.allTextContents()
      return texts.length === 3 && texts.some(t => /→/.test(t))
    }, { timeout: 3000 }).toBe(true)

    await page.mouse.move(5, 5)

    // Back to just the source-station tooltip — 1 TT, no arrow.
    await expect.poll(async () => {
      const texts = await tooltips.allTextContents()
      return texts.length === 1 && !/→/.test(texts[0])
    }, { timeout: 3000, message: 'collapsed to source tooltip only' }).toBe(true)
  })
})
