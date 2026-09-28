import { test, expect } from '@playwright/test'

/**
 * `/timelapse` (`specs/timelapse-map.md` P1): the GL surface mounts, the
 * clock shows the URL's `t`, and stepping writes `t` back (replace) after a
 * pause. No WebGL-pixel assertions (headless canvases capture black between
 * maplibre renders). The frame data path (interim shard/synth sources) is
 * exercised only as far as "no page errors": the shard read hits
 * `data.ctbk.dev`, so the clock/URL assertions don't wait on it.
 */
test('clock follows `t`; → steps `t` in the URL after pause', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/timelapse?d=260604-260806&t=260620')

  await expect(page.locator('.maplibregl-map')).toHaveCount(1)
  await expect(page.getByTestId('tl-clock')).toHaveText('Sat, Jun 20, 2026')
  await expect(page.getByRole('button', { name: 'Play' })).toHaveCount(1)

  // Play, then pause: the URL is rewritten only on pause (never per frame).
  await page.getByRole('button', { name: 'Play' }).click()
  await expect(page.getByRole('button', { name: 'Pause' })).toHaveCount(1)
  await page.getByRole('button', { name: 'Pause' }).click()
  await expect(page.getByRole('button', { name: 'Play' })).toHaveCount(1)
  const paused = new URL(page.url()).searchParams.get('t')!
  expect(paused).toMatch(/^26(06|07|08)\d{2}$/)

  // → steps one day: `t` advances by exactly one calendar day.
  await page.locator('body').press('ArrowRight')
  const next = new Date(Date.UTC(2000 + Number(paused.slice(0, 2)), Number(paused.slice(2, 4)) - 1, Number(paused.slice(4, 6)) + 1))
  const expected = `${String(next.getUTCFullYear() % 100).padStart(2, '0')}${String(next.getUTCMonth() + 1).padStart(2, '0')}${String(next.getUTCDate()).padStart(2, '0')}`
  await expect.poll(() => new URL(page.url()).searchParams.get('t')).toBe(expected)
  await expect(page.getByTestId('tl-clock')).toHaveText(
    new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(next),
  )
  expect(errors).toEqual([])
})
