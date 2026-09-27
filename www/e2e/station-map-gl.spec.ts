import { test, expect } from '@playwright/test'

/**
 * `/stations?gl=1`: deck.gl-over-MapLibre GPU map (see
 * `specs/unified-page-architecture.md` "Rendering architecture"). WebGL
 * pixels aren't asserted (headless canvases capture black between maplibre
 * renders); this pins that the GL surface mounts in place of Leaflet, with
 * the lens legend + arc fan path running without page errors.
 */
test('GL map mounts with lens legend + arc fan, no page errors', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/stations?gl=1&fan=1&sel=6450.12')

  await expect(page.locator('.maplibregl-map')).toHaveCount(1)
  await expect(page.locator('.leaflet-container')).toHaveCount(0)
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
