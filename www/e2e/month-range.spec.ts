import { test, expect, Page } from '@playwright/test'

/**
 * MonthRangePicker: start/end YY-MM text inputs that commit on blur and
 * (per the URL codec in `date-range.ts`) encode the selected range into
 * the `d` query param:
 *   - absent (default):              "All"
 *   - start only:                    `d=YYMM-`
 *   - start + end:                   `d=YYMM-YYMM`
 */

const ready = async (page: Page) => {
  await page.goto('/')
  await page.waitForSelector('.plotly')
}

const start = (page: Page) => page.getByLabel('Start month')
const end = (page: Page) => page.getByLabel('End month')

const d = (page: Page) => new URL(page.url()).searchParams.get('d')

test.describe('MonthRangePicker', () => {
  test('typing "2501" in start sets d=2501-', async ({ page }) => {
    await ready(page)
    expect(d(page)).toBeNull()

    await start(page).fill('2501')
    await start(page).blur()

    await expect.poll(() => d(page)).toBe('2501-')
    await expect(start(page)).toHaveValue('25-01')
  })

  test('clearing start (with no end) removes d param entirely', async ({ page }) => {
    await ready(page)

    await start(page).fill('2501')
    await start(page).blur()
    await expect.poll(() => d(page)).toBe('2501-')

    await start(page).fill('')
    await start(page).blur()

    await expect.poll(() => d(page)).toBeNull()
    await expect(start(page)).toHaveValue('')
  })

  test('typing start + end sets d=YYMM-YYMM', async ({ page }) => {
    await ready(page)

    await start(page).fill('2501')
    await start(page).blur()
    await end(page).fill('2506')
    await end(page).blur()

    await expect.poll(() => d(page)).toBe('2501-2506')
  })

  test('clearing both start and end removes d param', async ({ page }) => {
    await ready(page)

    await start(page).fill('2501')
    await start(page).blur()
    await end(page).fill('2506')
    await end(page).blur()
    await expect.poll(() => d(page)).toBe('2501-2506')

    await end(page).fill('')
    await end(page).blur()
    await start(page).fill('')
    await start(page).blur()

    await expect.poll(() => d(page)).toBeNull()
  })

  test('Enter key commits value (no explicit blur)', async ({ page }) => {
    await ready(page)

    await start(page).fill('2501')
    await start(page).press('Enter')

    await expect.poll(() => d(page)).toBe('2501-')
  })

  test('invalid input reverts to last committed value', async ({ page }) => {
    await ready(page)

    await start(page).fill('2501')
    await start(page).blur()
    await expect.poll(() => d(page)).toBe('2501-')

    await start(page).fill('9999')
    await start(page).blur()

    await expect.poll(() => d(page)).toBe('2501-')
    await expect(start(page)).toHaveValue('25-01')
  })

  test('clearing end (start still set) keeps start: d=YYMM-', async ({ page }) => {
    await ready(page)

    await start(page).fill('2501')
    await start(page).blur()
    await end(page).fill('2506')
    await end(page).blur()
    await expect.poll(() => d(page)).toBe('2501-2506')

    await end(page).fill('')
    await end(page).blur()

    await expect.poll(() => d(page)).toBe('2501-')
  })
})
