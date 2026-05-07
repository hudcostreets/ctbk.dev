import { test, expect, Page } from '@playwright/test'

/**
 * Home chart update behavior — guards against the two regressions fixed in
 * b90933d5 (yaxis.uirevision) and 021a93a3 (Home plotKey remount):
 *
 *   1. Toggling a region checkbox (data-only change, same trace shape)
 *      must rescale the y-axis.
 *   2. Clicking an Examples link (trace-shape change via React Router nav)
 *      must update the legend AND the y-axis to reflect the new state.
 *
 * Both bugs presented as "URL/controls update but chart visualization stays
 * stale" — so the assertions read directly from plotly's rendered SVG
 * (legend text, y-tick labels) rather than from React state.
 */

const ready = async (page: Page) => {
  await page.goto('/')
  await page.waitForSelector('.plotly')
  // Wait one paint after data loads so plotly has computed its first autorange.
  await page.waitForFunction(() => {
    const ticks = document.querySelectorAll('.js-plotly-plot .ytick text')
    return ticks.length > 1
  })
}

const yTicks = (page: Page) =>
  page.locator('.js-plotly-plot .ytick text').allTextContents()

const legendItems = (page: Page) =>
  page.locator('.js-plotly-plot .legendtext').allTextContents()

/** Convert a y-tick label like "5M" / "120k" / "0" to a number. */
const parseTick = (s: string): number => {
  const m = s.match(/^([\d.]+)([Mk%]?)$/)
  if (!m) return NaN
  const n = parseFloat(m[1])
  if (m[2] === 'M') return n * 1e6
  if (m[2] === 'k') return n * 1e3
  return n
}

const yMax = async (page: Page): Promise<number> => {
  const ticks = await yTicks(page)
  const numeric = ticks.map(parseTick).filter((n) => !isNaN(n))
  return Math.max(...numeric)
}

test.describe('Home chart updates', () => {
  test('Region toggle (NYC off) rescales y-axis down', async ({ page }) => {
    await ready(page)

    // Default: all regions, y-axis ~5M (system-wide rides).
    const yMaxAll = await yMax(page)
    expect(yMaxAll).toBeGreaterThan(2_000_000)

    // Toggle NYC off → only JC + HOB → y-axis should drop ~50× (to ~120k).
    await page.getByRole('checkbox', { name: 'NYC' }).click()
    await expect.poll(async () => yMax(page), { timeout: 5000 }).toBeLessThan(
      yMaxAll / 5,
    )
  })

  test('Region toggle (NYC back on) rescales y-axis up', async ({ page }) => {
    // Start with JC + HOB only.
    await page.goto('/?r=jh')
    await page.waitForSelector('.plotly')
    await page.waitForFunction(() => {
      return document.querySelectorAll('.js-plotly-plot .ytick text').length > 1
    })

    const yMaxJH = await yMax(page)
    expect(yMaxJH).toBeLessThan(500_000)

    await page.getByRole('checkbox', { name: 'NYC' }).click()
    await expect.poll(async () => yMax(page), { timeout: 5000 }).toBeGreaterThan(
      yMaxJH * 5,
    )
  })

  test('Examples link "Classic / E-bike ride minutes" updates legend + y-axis', async ({ page }) => {
    await ready(page)

    // Default: single "Rides" trace + "12mo avg" line.
    expect(await legendItems(page)).toEqual(['Rides', '12mo avg'])
    const yMaxDefault = await yMax(page)
    expect(yMaxDefault).toBeLessThan(10_000_000) // Rides scale, not Minutes scale

    // Click Examples link: stack by Bike Type, Minutes, dates from 2020-02.
    await page.getByRole('link', { name: 'Classic / E-bike ride minutes' }).first().click()

    // Legend reflects new trace identities — Classic + Electric stacked, plus 12mo lines.
    await expect.poll(async () => legendItems(page), { timeout: 5000 }).toEqual(
      expect.arrayContaining(['Classic', 'Electric']),
    )
    // Y-axis recomputes for Minutes scale (10× higher than Rides).
    await expect.poll(async () => yMax(page), { timeout: 5000 }).toBeGreaterThan(20_000_000)
  })

  test('Examples link "Member vs. customer %" switches to percent y-axis', async ({ page }) => {
    await ready(page)

    await page.getByRole('link', { name: "Member vs. customer %'s" }).first().click()

    // Legend reflects new traces.
    await expect.poll(async () => legendItems(page), { timeout: 5000 }).toEqual(
      expect.arrayContaining(['Member', 'Customer']),
    )

    // Y-ticks are percentages.
    await expect.poll(async () => yTicks(page), { timeout: 5000 }).toEqual(
      expect.arrayContaining(['0%']),
    )
  })

  test('Returning to default view from a custom link resets the chart', async ({ page }) => {
    await page.goto('/?y=m&s=b&rt=ce&d=2002-')
    await page.waitForSelector('.plotly')
    await expect
      .poll(async () => legendItems(page), { timeout: 5000 })
      .toEqual(expect.arrayContaining(['Classic', 'Electric']))

    await page.getByRole('link', { name: 'Default view' }).first().click()

    await expect.poll(async () => legendItems(page), { timeout: 5000 }).toEqual(
      ['Rides', '12mo avg'],
    )
  })
})
