import type { Page } from '@playwright/test'

/**
 * Helpers for the GL (deck.gl + MapLibre) station maps. WebGL pixels can't be
 * inspected (headless canvases capture black between renders), so station
 * screen positions are computed from the camera the test itself set:
 * Web-Mercator projection (MapLibre's 512px world tiles) of a station's
 * `[lat, lng]` relative to the map's center, which sits at the center of the
 * `.maplibregl-map` container.
 */

export type Station = { id: string; name: string; lat: number; lng: number; ends: number }

/** Latest-month stations (the `/stations` + Home embed default month). */
export async function latestStations(page: Page): Promise<Station[]> {
  return page.evaluate(async () => {
    const manifest = await (await fetch('/assets/station-urls.json')).json()
    const data: Record<string, { name: string; lat: number; lng: number; ends: number }> =
      await (await fetch(manifest.stations[manifest.latestMonth])).json()
    return Object.entries(data).map(([id, s]) => ({ id, name: s.name, lat: s.lat, lng: s.lng, ends: s.ends }))
  })
}

function mercator(lat: number, lng: number, zoom: number): [number, number] {
  const ws = 512 * 2 ** zoom
  const x = ((lng + 180) / 360) * ws
  const phi = (lat * Math.PI) / 180
  const y = ((1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2) * ws
  return [x, y]
}

/** Viewport px of `[lat, lng]` on the (first) GL map, whose camera is
 *  `center` (`[lat, lng]`) at `zoom`. */
export async function screenPos(
  page: Page,
  at: { lat: number; lng: number },
  center: { lat: number; lng: number },
  zoom: number,
): Promise<{ x: number; y: number }> {
  const box = await page.locator('.maplibregl-map').first().boundingBox()
  if (!box) throw new Error('no GL map on the page')
  const [px, py] = mercator(at.lat, at.lng, zoom)
  const [cx, cy] = mercator(center.lat, center.lng, zoom)
  return { x: box.x + box.width / 2 + (px - cx), y: box.y + box.height / 2 + (py - cy) }
}

/** Wait until the GL map has loaded its basemap style (deck is live by then). */
export async function waitForGLMap(page: Page) {
  await page.waitForSelector('.maplibregl-map canvas.maplibregl-canvas')
  await page.waitForFunction(() => document.querySelectorAll('.maplibregl-map canvas').length >= 2, null, { timeout: 15_000 })
}
