import { test, expect, type Page } from '@playwright/test'
import { latestStations, screenPos, waitForGLMap, type Station } from './glMap'

/**
 * `/stations`: the deck.gl-over-MapLibre GPU map is the default (`?gl=0` →
 * Leaflet), with the shared `lib/mapSelection` model (as on `/timelapse`).
 * Stations are located by projecting their coordinates from the default
 * camera (`glMap.ts`); WebGL pixels aren't asserted.
 */

const CENTER = { lat: 40.758, lng: -73.965 }
const ZOOM = 12

type Placed = Station & { x: number; y: number }

/** Stations with their screen positions, busiest first, restricted to a band
 *  of the map clear of the title bar / legend / rides panel. */
async function placedStations(page: Page): Promise<Placed[]> {
  const all = await latestStations(page)
  const out: Placed[] = []
  for (const s of all) {
    const p = await screenPos(page, s, CENTER, ZOOM)
    out.push({ ...s, ...p })
  }
  return out.sort((a, b) => b.ends - a.ends)
}

const inBand = (s: Placed) => s.x > 150 && s.x < 1000 && s.y > 200 && s.y < 420

/** Two busy stations ≥ 40px apart, each ≥ 15px from any other station (so a
 *  click picks exactly it). */
function twoStations(all: Placed[]): [Placed, Placed] {
  const isolated = (s: Placed) => all.every((o) => o === s || Math.hypot(o.x - s.x, o.y - s.y) >= 15)
  const cands = all.filter((s) => inBand(s) && isolated(s))
  const a = cands[0]
  const b = cands.find((s) => Math.hypot(s.x - a.x, s.y - a.y) >= 40)
  if (!a || !b) throw new Error('no isolated station pair in view')
  return [a, b]
}

/** A point in the band with no station within 30px. */
function emptySpot(all: Placed[]): { x: number; y: number } {
  for (let y = 220; y < 420; y += 10) {
    for (let x = 160; x < 1000; x += 10) {
      if (all.every((s) => Math.hypot(s.x - x, s.y - y) >= 30)) return { x, y }
    }
  }
  throw new Error('no empty spot in view')
}

/** ⌘-click (`mouse.click` takes no modifiers). */
async function metaClick(page: Page, at: { x: number; y: number }) {
  await page.keyboard.down('Meta')
  await page.mouse.click(at.x, at.y)
  await page.keyboard.up('Meta')
}

const selOf = (page: Page) => new URL(page.url()).searchParams.get('sel')

async function openStations(page: Page, query = '') {
  await page.goto(`/stations${query}`)
  await waitForGLMap(page)
  await expect(page.getByText('Loading...')).toHaveCount(0, { timeout: 15_000 })
  // Let deck upload the station layer before picking.
  await page.waitForTimeout(500)
}

test.describe('Station map (GL default)', () => {
  test('GL by default; `?gl=0` falls back to Leaflet; old `?gl=1` links still GL', async ({ page }) => {
    await page.goto('/stations')
    await expect(page.locator('.maplibregl-map')).toHaveCount(1)
    await expect(page.locator('.leaflet-container')).toHaveCount(0)

    await page.goto('/stations?gl=0')
    await expect(page.locator('.leaflet-container')).toHaveCount(1)
    await expect(page.locator('.maplibregl-map')).toHaveCount(0)

    await page.goto('/stations?gl=1')
    await expect(page.locator('.maplibregl-map')).toHaveCount(1)
    await expect(page.locator('.leaflet-container')).toHaveCount(0)
  })

  test('lens legend + arc fan, no page errors', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('/stations?fan=1&sel=6450.12')

    await expect(page.locator('.maplibregl-map')).toHaveCount(1)
    // Lens legend names the source station, confirming pairs loaded + `flowLens` ran.
    const source = page.locator('[class*="lensSource"]')
    await expect(source.locator('strong')).toHaveText('8 Ave & W 33 St', { timeout: 15_000 })
    await expect(source).toContainText(/^Trips from /)

    // ⇄ flips the lens (and arc fan) direction via `?dir=`.
    await page.getByRole('button', { name: /where riders go/ }).click()
    await expect(source).toContainText(/^Trips to /)
    await expect.poll(() => new URL(page.url()).searchParams.get('dir')).toBe('i')
    expect(errors).toEqual([])
  })

  test('lens keys: size/color circles (descending counts + "no trips"), arc widths when `fan=1`', async ({ page }) => {
    await page.goto('/stations?fan=1&sel=6450.12')
    const labels = (key: string) => page.getByTestId(key).locator(':scope > span > span').allTextContents()
    await expect(page.getByTestId('lens-size-key')).toBeVisible({ timeout: 15_000 })
    const size = await labels('lens-size-key')
    expect(size.at(-1)).toBe('no trips')
    const counts = size.slice(0, -1).map((t) => Number(t.replace(/,/g, '')))
    expect(counts.length).toBeGreaterThanOrEqual(2)
    expect(counts).toEqual([...counts].sort((a, b) => b - a))
    const widths = (await labels('lens-width-key')).map((t) => Number(t.replace(/,/g, '')))
    expect(widths.length).toBeGreaterThanOrEqual(2)
    expect(widths).toEqual([...widths].sort((a, b) => b - a))

    // No fan → no width key.
    await page.goto('/stations?sel=6450.12')
    await expect(page.getByTestId('lens-size-key')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('lens-width-key')).toHaveCount(0)
  })

  test('Arcs toggle updates the URL, survives reload, and preserves the map view', async ({ page }) => {
    await page.goto('/stations?sel=6450.12&dir=i&ll=40.751-73.994+14.00')
    const toggle = page.getByRole('checkbox', { name: 'Arcs', exact: true })
    await expect(toggle).toBeVisible({ timeout: 15_000 })
    await expect(toggle).not.toBeChecked()
    await expect(page.getByTestId('lens-width-key')).toHaveCount(0)
    const view = new URL(page.url()).searchParams.get('ll')
    const state = () => {
      const params = new URL(page.url()).searchParams
      return Object.fromEntries(['fan', 'sel', 'dir', 'll'].map((key) => [key, params.get(key)]))
    }

    await toggle.check()
    await expect.poll(state).toEqual({ fan: '', sel: '6450.12', dir: 'i', ll: view })
    await expect(page.getByTestId('lens-width-key')).toBeVisible()
    await page.reload()
    await expect(toggle).toBeChecked({ timeout: 15_000 })
    await expect(page.getByTestId('lens-width-key')).toBeVisible()

    await toggle.uncheck()
    await expect.poll(state).toEqual({ fan: null, sel: '6450.12', dir: 'i', ll: view })
    await expect(page.getByTestId('lens-width-key')).toHaveCount(0)
    await expect(page.getByTestId('source-info').locator('[class*="hoverDrawerName"]')).toHaveText('8 Ave & W 33 St')
  })

  test('tap selects one, ⌘-click toggles, empty tap clears, back undoes', async ({ page }) => {
    await openStations(page)
    const all = await placedStations(page)
    const [a, b] = twoStations(all)

    await page.mouse.click(a.x, a.y)
    await expect.poll(() => selOf(page)).toBe(a.id)
    await page.mouse.click(b.x, b.y)
    await expect.poll(() => selOf(page)).toBe(b.id)
    await metaClick(page, a)
    await expect.poll(() => selOf(page)).toBe(`${b.id},${a.id}`)
    await metaClick(page, b)
    await expect.poll(() => selOf(page)).toBe(a.id)

    const empty = emptySpot(all)
    await page.mouse.click(empty.x, empty.y)
    await expect.poll(() => selOf(page)).toBe(null)

    // Each edit is a history entry: back restores the previous set.
    await page.goBack()
    await expect.poll(() => selOf(page)).toBe(a.id)
  })

  test('long-press → multi-select (taps toggle, empty taps keep the set) → Done; Esc clears', async ({ page }) => {
    await openStations(page)
    const all = await placedStations(page)
    const [a, b] = twoStations(all)

    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await page.waitForTimeout(700)
    await page.mouse.up()
    // The mode shows in the rides panel's header (chips + Done).
    await expect(page.getByTestId('multi-mode')).toHaveCount(1)
    await expect.poll(() => selOf(page)).toBe(a.id)

    await page.mouse.click(b.x, b.y)
    await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(2)
    const empty = emptySpot(all)
    await page.mouse.click(empty.x, empty.y)
    await expect.poll(() => selOf(page)).toBe(`${a.id},${b.id}`)

    await page.getByTestId('multi-done').click()
    await expect(page.getByTestId('multi-mode')).toHaveCount(0)
    await expect.poll(() => selOf(page)).toBe(`${a.id},${b.id}`)

    await page.keyboard.press('Escape')
    await expect.poll(() => selOf(page)).toBe(null)
  })

  test('shift-drag box-selects the stations inside it', async ({ page }) => {
    await openStations(page)
    const all = await placedStations(page)
    const [a] = twoStations(all)
    const r = { x0: a.x - 25, y0: a.y - 25, x1: a.x + 25, y1: a.y + 25 }
    const inside = all.filter((s) => s.x >= r.x0 && s.x <= r.x1 && s.y >= r.y0 && s.y <= r.y1).map((s) => s.id).sort()

    await page.keyboard.down('Shift')
    await page.mouse.move(r.x0, r.y0)
    await page.mouse.down()
    await page.mouse.move(a.x, a.y, { steps: 3 })
    await page.mouse.move(r.x1, r.y1, { steps: 3 })
    await page.mouse.up()
    await page.keyboard.up('Shift')

    await expect.poll(() => (selOf(page) ?? '').split(',').filter(Boolean).sort()).toEqual(inside)
    await expect(page.getByTestId('multi-mode')).toHaveCount(0)
  })
})

test.describe('Station map, phone layout', () => {
  test.use({ viewport: { width: 400, height: 820 }, hasTouch: true })

  type Box = { x: number; y: number; width: number; height: number }
  const overlaps = (a: Box, b: Box) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

  test('header strip + legend collapse; rides panel collapses; nothing overlaps', async ({ page }) => {
    await page.goto('/stations?fan=1&sel=6551.11,6464.08,6593.14,6450.12')
    const header = page.getByTestId('stations-header')
    const legend = page.getByTestId('lens-legend')
    await expect(legend.locator('strong')).toHaveText('E 43 St & Madison Ave +3 more', { timeout: 15_000 })
    // Legend starts collapsed to its summary line, inside the header strip.
    await expect(page.getByTestId('lens-size-key')).toHaveCount(0)
    await legend.getByRole('button', { name: 'Show legend' }).click()
    await expect(page.getByTestId('lens-size-key')).toBeVisible()
    const arcs = legend.getByRole('checkbox', { name: 'Arcs', exact: true })
    await expect(arcs).toBeChecked()
    await arcs.uncheck()
    await expect.poll(() => new URL(page.url()).searchParams.get('fan')).toBe(null)
    await expect(page.getByTestId('lens-width-key')).toHaveCount(0)
    await arcs.check()
    await expect.poll(() => new URL(page.url()).searchParams.get('fan')).toBe('')
    await expect(page.getByTestId('lens-width-key')).toBeVisible()
    await legend.getByRole('button', { name: 'Hide legend' }).click()
    await expect(page.getByTestId('lens-size-key')).toHaveCount(0)

    const panel = page.getByTestId('rides-panel')
    const dial = page.locator('.kbd-speed-dial')
    // Controls behind ⚙; collapse leaves just the bar.
    await expect(page.getByTestId('rides-controls')).toHaveCount(0)
    await page.getByTestId('rides-gear').click()
    await expect(page.getByTestId('rides-controls')).toBeVisible()
    const expandedH = (await panel.boundingBox())!.height
    await page.getByTestId('rides-collapse').click()
    await expect(page.getByTestId('rides-controls')).toHaveCount(0)
    await expect.poll(async () => (await panel.boundingBox())!.height).toBeLessThan(expandedH)

    for (const open of [false, true]) {
      if (open) await page.getByTestId('rides-collapse').click()
      await page.waitForTimeout(200)
      const [h, p, d] = await Promise.all([header.boundingBox(), panel.boundingBox(), dial.boundingBox()])
      expect([overlaps(h!, p!), overlaps(d!, p!), overlaps(d!, h!)]).toEqual([false, false, false])
    }
  })
})
