import { test, expect, Page } from '@playwright/test'

/**
 * Station detail pages (`/s/:id`): a retired station, an active one, and
 * redirects from earlier slugs / short names to the current slug.
 *
 * `/api/stations/<id>/info` is stubbed with what the api returns after the
 * slug migration (`gbfs/d1/load_station_slugs.py`): current `slug`, plus
 * `alias` when looked up by an earlier one. Everything else (availability,
 * station state, map month data) is live, as in the other specs.
 */

const RETIRED = {
  short_name: '4452.01', gbfs_station_id: null, name: 'Lafayette Ave & Classon Ave',
  lat: 40.689, lon: -73.9602, capacity: null, station_type: null,
  first_seen: '2013-06-01', last_seen: '2024-06-07', in_gbfs: 0, slug: 'lafayette+classon',
}
const ACTIVE = {
  short_name: '4129.10', gbfs_station_id: 'cf1a96a7-f695-4ba2-bcf2-899552e21e47',
  name: 'Herkimer St & Eastern Pkwy', lat: 40.67738, lon: -73.90829, capacity: 20,
  station_type: 'classic', first_seen: '2022-12-07', last_seen: null, in_gbfs: 1, slug: 'herkimer+eastern',
}
/** Lookup key → [station, earlier slug it's an alias of?]. */
const INFO: Record<string, [typeof RETIRED | typeof ACTIVE, boolean]> = {
  'lafayette+classon': [RETIRED, false],
  '4452.01': [RETIRED, false],
  'lafayette-ave-classon-ave': [RETIRED, true],
  'herkimer+eastern': [ACTIVE, false],
  '4129.10': [ACTIVE, false],
  'herkimer-st-eastern-pkwy': [ACTIVE, true],
}

async function stubInfo(page: Page) {
  await page.route(/\/api\/stations\/([^/]+)\/info$/, (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3])
    const hit = INFO[id]
    if (!hit) return route.fulfill({ status: 404, json: { error: `Station not found: ${id}` } })
    const [station, isAlias] = hit
    return route.fulfill({ json: isAlias ? { ...station, alias: id } : station })
  })
}

const path = (page: Page) => new URL(page.url()).pathname

test.describe('Station page', () => {
  test.beforeEach(({ page }) => stubInfo(page))

  test('retired station: badge + active range, availability replaced by a note, map on its last month', async ({ page }) => {
    await page.goto('/s/lafayette+classon')
    const h = page.locator('h5').first()
    await expect(h).toHaveText('Lafayette Ave & Classon Averetired 2024')
    await expect(page.getByText('#4452.01 · 2013-06-01 – 2024-06-07')).toBeVisible()
    await expect(page.getByText(/^No availability data: this station was retired \(last ride 2024-06-07\)/)).toBeVisible()
    // No never-resolving spinner, no avail/station-state controls.
    await expect(page.getByText(/Loading availability/)).toHaveCount(0)
    await expect(page.getByText('Station state')).toHaveCount(0)
    await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.leaflet-container').locator('..').locator('select')).toHaveValue('202406')
  })

  test('active station: no retired badge; availability controls + chart area', async ({ page }) => {
    await page.goto('/s/herkimer+eastern')
    await expect(page.locator('h5').first()).toHaveText('Herkimer St & Eastern Pkwy')
    await expect(page.getByText('#4129.10 · 20 docks · classic · since 2022-12-07')).toBeVisible()
    await expect(page.getByText('Range:')).toBeVisible()
    await expect(page.getByText('Station state')).toBeVisible()
    await expect(page.getByText(/No availability data/)).toHaveCount(0)
  })

  test('active station: window summary + by-hour panel; Weekdays solo updates the URL', async ({ page }) => {
    await page.goto('/s/herkimer+eastern')
    // Live data: normalize the numbers, assert the shape and stat order.
    const summary = page.getByTestId('smg-summary')
    await expect(summary).toBeVisible({ timeout: 30_000 })  // live smg-v1; cold worker
    const text = (await summary.innerText()).replace(/\s+/g, ' ').trim()
    expect(text.replace(/[\d.]+%/g, 'N%').replace(/^\w{3} \d+ – \w{3} \d+:/, 'SPAN:')).toBe(
      'SPAN: N% empty N% full N% no e-bikes N% offline N% unmeasured',
    )

    await expect(page.getByTestId('smg-grid').locator('canvas').last()).toBeVisible({ timeout: 30_000 })

    const byHour = page.getByTestId('smg-by-hour')
    await expect(byHour.locator('summary')).toHaveText('All days')
    await expect(byHour.locator('.js-plotly-plot')).toBeVisible({ timeout: 30_000 })
    await byHour.locator('summary').click()
    await byHour.getByText('Weekdays', { exact: true }).locator('xpath=..').getByText('only').click()
    await expect(byHour.locator('summary')).toHaveText('Weekdays')
    expect(new URL(page.url()).searchParams.get('hd')).toBe('mtwrf')
  })

  for (const [from, to] of [
    ['/s/lafayette-ave-classon-ave', '/s/lafayette+classon'],
    ['/s/4452.01', '/s/lafayette+classon'],
    ['/s/lafayette%2Bclasson', '/s/lafayette+classon'],
    ['/s/herkimer-st-eastern-pkwy', '/s/herkimer+eastern'],
    ['/stations/4129.10', '/s/herkimer+eastern'],
  ]) {
    test(`${from} redirects to ${to}, keeping the query`, async ({ page }) => {
      await page.goto(`${from}?r=1d`)
      await expect.poll(() => path(page)).toBe(to)
      expect(new URL(page.url()).search).toBe('?r=1d')
    })
  }
})
