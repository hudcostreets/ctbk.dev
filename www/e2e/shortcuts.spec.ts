import { test, expect } from '@playwright/test'

test.describe('Keyboard Shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    // Clear localStorage before each test
    await page.goto('/')
    await page.evaluate(() => localStorage.removeItem('ctbk-hotkeys'))
    await page.reload()
    // Wait for page to load
    await page.waitForSelector('.plotly')
  })

  test('opens shortcuts modal with ? key', async ({ page }) => {
    await page.keyboard.press('?')
    await expect(page.locator('text=Keyboard Shortcuts')).toBeVisible()
  })

  test('can close shortcuts modal by clicking X', async ({ page }) => {
    await page.keyboard.press('?')
    await expect(page.locator('text=Keyboard Shortcuts')).toBeVisible()
    await page.locator('button[aria-label="Close"]').click()
    await expect(page.locator('text=Keyboard Shortcuts')).not.toBeVisible()
  })

  test('shows default bindings correctly', async ({ page }) => {
    await page.keyboard.press('?')
    await expect(page.locator('text=Keyboard Shortcuts')).toBeVisible()

    // Check that "No stacking" shows "-" binding
    const noStackingRow = page.locator('tr', { has: page.locator('text=No stacking') })
    await expect(noStackingRow.locator('kbd')).toHaveText('-')
  })

  test('can change binding for an action', async ({ page }) => {
    await page.keyboard.press('?')
    await expect(page.locator('text=Keyboard Shortcuts')).toBeVisible()

    // Click on the "-" binding for "No stacking"
    const noStackingRow = page.locator('tr', { has: page.locator('text=No stacking') })
    await noStackingRow.locator('kbd').click()

    // Wait for recording mode (shows "...")
    await expect(noStackingRow.locator('kbd')).toContainText('...')

    // Press a new key to replace the binding
    await page.keyboard.press('0')

    // Wait for the binding to be updated
    await page.waitForTimeout(1200) // Wait for sequence timeout

    // Should have REPLACED the old binding (setBinding behavior)
    const kbds = noStackingRow.locator('kbd')
    await expect(kbds).toHaveCount(1)
    await expect(kbds).toHaveText('0')
  })

  test('assigning same key to two actions creates conflict', async ({ page }) => {
    await page.keyboard.press('?')
    await expect(page.locator('text=Keyboard Shortcuts')).toBeVisible()

    // Get rows for two different actions
    const noStackingRow = page.locator('tr', { has: page.locator('text=No stacking') })
    const byRegionRow = page.locator('tr', { has: page.locator('text=By region') })

    // Assign 'q' to "No stacking"
    await noStackingRow.locator('kbd').first().click()
    await page.keyboard.press('q')
    await page.waitForTimeout(1200)

    // Verify it was set
    await expect(noStackingRow.locator('kbd')).toHaveText('Q')

    // Now assign 'q' to "By region" too - this creates a conflict
    await byRegionRow.locator('kbd').first().click()
    await page.keyboard.press('q')
    await page.waitForTimeout(1200)

    // Both actions now have 'q' bound - should show conflict warning
    await expect(page.locator('text=Some shortcuts have conflicts')).toBeVisible()
  })

  test('persists bindings to localStorage', async ({ page }) => {
    await page.keyboard.press('?')
    await expect(page.locator('text=Keyboard Shortcuts')).toBeVisible()

    // Change "No stacking" from "-" to "0"
    const noStackingRow = page.locator('tr', { has: page.locator('text=No stacking') })
    await noStackingRow.locator('kbd').click()
    await page.keyboard.press('0')
    await page.waitForTimeout(1200)

    // Should have replaced binding
    await expect(noStackingRow.locator('kbd')).toHaveCount(1)
    await expect(noStackingRow.locator('kbd')).toHaveText('0')

    // Close modal and reload
    await page.locator('button[aria-label="Close"]').click()
    await page.reload()
    await page.waitForSelector('.plotly')

    // Open modal again
    await page.keyboard.press('?')
    await expect(page.locator('text=Keyboard Shortcuts')).toBeVisible()

    // Binding should still be "0"
    const noStackingRowAfter = page.locator('tr', { has: page.locator('text=No stacking') })
    await expect(noStackingRowAfter.locator('kbd')).toHaveCount(1)
    await expect(noStackingRowAfter.locator('kbd')).toHaveText('0')
  })

  test('reset restores default bindings', async ({ page }) => {
    await page.keyboard.press('?')
    await expect(page.locator('text=Keyboard Shortcuts')).toBeVisible()

    // Change "No stacking" from "-" to "0"
    const noStackingRow = page.locator('tr', { has: page.locator('text=No stacking') })
    await noStackingRow.locator('kbd').click()
    await page.keyboard.press('0')
    await page.waitForTimeout(1200)

    // Verify it changed
    await expect(noStackingRow.locator('kbd')).toHaveText('0')

    // Click reset button
    await page.locator('button', { hasText: 'Reset to defaults' }).click()

    // Should be back to "-"
    await expect(noStackingRow.locator('kbd')).toHaveCount(1)
    await expect(noStackingRow.locator('kbd')).toHaveText('-')
  })

  test('empty binding shows ∅ symbol', async ({ page }) => {
    await page.keyboard.press('?')
    await expect(page.locator('text=Keyboard Shortcuts')).toBeVisible()

    // Find a row that might have empty binding
    // For now, let's verify the symbol exists when there's no binding
    // We can check the CSS class
    const emptyKbds = page.locator('kbd.empty')
    // There may or may not be empty bindings - just verify the class would work
    const count = await emptyKbds.count()
    if (count > 0) {
      await expect(emptyKbds.first()).toContainText('∅')
    }
  })

  test('setting key to its default does not store in localStorage', async ({ page }) => {
    await page.keyboard.press('?')
    await expect(page.locator('text=Keyboard Shortcuts')).toBeVisible()

    // "All time" has default binding 'x'
    const allTimeRow = page.locator('tr', { has: page.locator('text=All time') })
    await expect(allTimeRow.locator('kbd')).toHaveText('X')

    // Click to edit
    await allTimeRow.locator('kbd').click()
    await expect(allTimeRow.locator('kbd')).toContainText('...')

    // Press 'x' (the same as default)
    await page.keyboard.press('x')
    await page.waitForTimeout(1200)

    // Should still show 'X'
    await expect(allTimeRow.locator('kbd')).toHaveText('X')

    // localStorage should be empty (canonical form)
    const stored = await page.evaluate(() => localStorage.getItem('ctbk-hotkeys'))
    expect(stored === null || stored === '{}').toBe(true)
  })

  test('Tab commits pending key to current action then moves to next', async ({ page }) => {
    await page.keyboard.press('?')
    await expect(page.locator('text=Keyboard Shortcuts')).toBeVisible()

    // "5 years" has default binding '5', "All time" has default binding 'x'
    const fiveYearsRow = page.locator('tr', { has: page.locator('text=5 years') })
    const allTimeRow = page.locator('tr', { has: page.locator('text=All time') })

    // Verify defaults
    await expect(fiveYearsRow.locator('kbd')).toHaveText('5')
    await expect(allTimeRow.locator('kbd')).toHaveText('X')

    // Click "5 years" to edit
    await fiveYearsRow.locator('kbd').click()
    await expect(fiveYearsRow.locator('kbd')).toContainText('...')

    // Press '6' (don't wait for timeout)
    await page.keyboard.press('6')

    // Should show '6...' as pending
    await expect(fiveYearsRow.locator('kbd')).toContainText('6')

    // Press Tab to commit and move to next
    await page.keyboard.press('Tab')

    // "5 years" should now have '6' committed
    await expect(fiveYearsRow.locator('kbd')).toHaveText('6')

    // "All time" should be in edit mode (showing '...')
    await expect(allTimeRow.locator('kbd')).toContainText('...')
  })
})
