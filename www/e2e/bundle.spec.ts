import { test, expect, Page } from '@playwright/test'

/**
 * Home-page bundle-size budget. Runs against `vite preview` so we measure
 * real shipped artifacts (minified + gzipped).
 *
 * Guards against:
 *  - regressions that pull heavy deps (e.g. leaflet, plotly, mapbox) back
 *    into the initial JS chunk
 *  - unintentional eager imports of non-critical routes
 *
 * Budgets are intentionally loose — tighten once we have a baseline.
 */

type Resource = { url: string; encoded: number; decoded: number; mime: string }

/**
 * Attach CDP network tracking. Returns a live array that gets populated
 * as responses complete. `encoded` = wire bytes (gzipped); `decoded` =
 * uncompressed bytes.
 */
async function trackNetwork(page: Page): Promise<Resource[]> {
  const resources: Resource[] = []
  const pending: Record<string, { url: string; mime: string }> = {}
  const client = await page.context().newCDPSession(page)
  await client.send('Network.enable')
  client.on('Network.responseReceived', (event) => {
    pending[event.requestId] = {
      url: event.response.url,
      mime: event.response.mimeType,
    }
  })
  client.on('Network.loadingFinished', (event) => {
    const meta = pending[event.requestId]
    if (!meta) return
    delete pending[event.requestId]
    resources.push({
      url: meta.url,
      mime: meta.mime,
      encoded: event.encodedDataLength,
      decoded: event.encodedDataLength, // Playwright doesn't surface decoded via CDP here; `encoded` is wire bytes
    })
  })
  return resources
}

const isJs = (r: Resource) =>
  /javascript/.test(r.mime) || /\.js(\?|$)/.test(r.url)

const isCss = (r: Resource) =>
  /css/.test(r.mime) || /\.css(\?|$)/.test(r.url)

/** Map chunks: the embed + GL map (and leaflet, which Home shouldn't load at all). */
const MAP_CHUNK = /StationMap|GLMap|maplibre|leaflet/i

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`

const fmtReport = (resources: Resource[]) => {
  const js = resources.filter(isJs).sort((a, b) => b.encoded - a.encoded)
  const css = resources.filter(isCss).sort((a, b) => b.encoded - a.encoded)
  const lines: string[] = ['JS:']
  for (const r of js) {
    const name = r.url.split('/').pop()
    lines.push(`  ${kb(r.encoded).padStart(9)}  ${name}`)
  }
  lines.push('CSS:')
  for (const r of css) {
    const name = r.url.split('/').pop()
    lines.push(`  ${kb(r.encoded).padStart(9)}  ${name}`)
  }
  return lines.join('\n')
}

test.describe('Bundle size (Home)', () => {
  test('initial JS transfer stays under budget', async ({ page }) => {
    const resources = await trackNetwork(page)
    await page.goto('/')
    // Wait for the plot to render so we capture everything the critical path loads.
    await page.waitForSelector('.plotly', { timeout: 30_000 })
    // Settle any deferred async imports (e.g. plotly.js/basic).
    await page.waitForLoadState('networkidle')

    const jsBytes = resources.filter(isJs).reduce((s, r) => s + r.encoded, 0)
    const cssBytes = resources.filter(isCss).reduce((s, r) => s + r.encoded, 0)

    const report = fmtReport(resources)
    console.log(`\nHome initial transfer:\n  total JS:  ${kb(jsBytes)}\n  total CSS: ${kb(cssBytes)}\n${report}`)

    // Budget (wire bytes, gzipped). Includes main chunk + deferred plotly.js
    // basic chunk, MUI/emotion splits, React vendor.
    //   Main chunk alone was ~184 KB gz at baseline.
    //   Plotly basic is ~360 KB gz.
    // Budget is loose to start; tighten after first green run.
    expect(jsBytes, 'initial JS transfer (gzipped)').toBeLessThan(800 * 1024)
    expect(cssBytes, 'initial CSS transfer (gzipped)').toBeLessThan(100 * 1024)
  })

  test('StationMap chunk is not loaded on initial Home render', async ({ page }) => {
    const resources = await trackNetwork(page)
    await page.goto('/')
    await page.waitForSelector('.plotly', { timeout: 30_000 })
    await page.waitForLoadState('networkidle')

    // The embed's map chunks (deck.gl + MapLibre via `StationMapGL` / `GLMap`)
    // should only load once the user scrolls the map section into view.
    const mapChunks = resources.filter(r => MAP_CHUNK.test(r.url))
    expect(mapChunks.map(r => r.url.split('/').pop()), 'no map chunks before scroll').toEqual([])
  })

  test('scrolling to map triggers the StationMap chunk load', async ({ page }) => {
    const resources = await trackNetwork(page)
    await page.goto('/')
    await page.waitForSelector('.plotly', { timeout: 30_000 })
    await page.waitForLoadState('networkidle')

    const before = resources.length
    await page.locator('#map').scrollIntoViewIfNeeded()
    // The GL map emits tile requests; wait for them.
    await page.waitForSelector('.maplibregl-map', { timeout: 15_000 })
    await page.waitForLoadState('networkidle')

    const added = resources.slice(before)
    const mapChunks = added.filter(r => MAP_CHUNK.test(r.url))
    expect(mapChunks.length, 'StationMap chunk loaded after scroll').toBeGreaterThan(0)
  })
})
