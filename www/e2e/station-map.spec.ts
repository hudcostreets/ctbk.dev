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

/**
 * Hover a rendered destination line and wait for the 3-tooltip state
 * (permanent source tooltip + `→` mid-edge tooltip + destination tooltip).
 *
 * Targets actual `path`s in the "lines" pane rather than a fixed offset
 * from the source station — which line fan exists at any pixel shifts with
 * each data month. Each polyline is a straight 2-point segment, so its
 * bbox center lies ON the line; try the longest few (midpoint farthest
 * from the source hit-circle, widest hover target) until one sticks.
 */
async function hoverDestinationLine(page: Page): Promise<boolean> {
  const tooltips = page.locator('.leaflet-container .leaflet-tooltip')
  const candidates = await page.evaluate(() => {
    const paths = document.querySelectorAll<SVGPathElement>('.leaflet-pane.leaflet-lines-pane path')
    return [...paths]
      .map(p => {
        const b = p.getBoundingClientRect()
        return { x: b.left + b.width / 2, y: b.top + b.height / 2, len: Math.hypot(b.width, b.height) }
      })
      .sort((a, b) => b.len - a.len)
      .slice(0, 5)
  })
  for (const { x, y } of candidates) {
    await page.mouse.move(x, y)
    try {
      await expect.poll(async () => {
        const texts = await tooltips.allTextContents()
        return texts.length === 3 && texts.filter(t => /→/.test(t)).length === 1
      }, { timeout: 1500 }).toBe(true)
      return true
    } catch {
      continue
    }
  }
  return false
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
    await selectBiggestStation(page)

    // Move cursor off the source station's hit area first — otherwise the
    // station's hover tooltip stacks on top of its permanent tooltip
    // (`hoverToSelect` mode renders both when cursor is on the hit circle).
    await page.mouse.move(5, 5)

    const tooltips = page.locator('.leaflet-container .leaflet-tooltip')
    await expect.poll(async () => await tooltips.count(),
      { timeout: 3000, message: 'baseline: source-station permanent tooltip only' }).toBe(1)
    expect(await tooltips.first().textContent()).not.toMatch(/→/)

    // While hovering a line: three tooltips. The source station's permanent
    // tooltip stays put, the mid-edge tooltip ("→ {dst}: {count}") appears,
    // and a permanent destination tooltip pops at the line's other end.
    expect(await hoverDestinationLine(page),
      '3 tooltips: 1 with "→", 2 plain (source + dest)').toBe(true)
  })

  test('moving the cursor off the line collapses back to the source tooltip', async ({ page }) => {
    await page.goto('/stations')
    await waitForStations(page)
    await selectBiggestStation(page)

    // Settle to baseline (just the permanent source TT, see test above).
    await page.mouse.move(5, 5)
    const tooltips = page.locator('.leaflet-container .leaflet-tooltip')
    await expect.poll(async () => await tooltips.count(), { timeout: 3000 }).toBe(1)

    // Hover a line (confirm transition to 3-tooltip state), then move far
    // away off the map.
    expect(await hoverDestinationLine(page), 'reached 3-tooltip hover state').toBe(true)

    await page.mouse.move(5, 5)

    // Back to just the source-station tooltip — 1 TT, no arrow.
    await expect.poll(async () => {
      const texts = await tooltips.allTextContents()
      return texts.length === 1 && !/→/.test(texts[0])
    }, { timeout: 3000, message: 'collapsed to source tooltip only' }).toBe(true)
  })
})

test.describe('Station map — multi-select rides panel', () => {
  test('clicking a station toggles it into `?sel=` and opens the rides panel', async ({ page }) => {
    await page.goto('/stations')
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
