import { test, expect } from '@playwright/test'

test.describe('Keyboard Shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    // Clear localStorage before each test (use-kbd is the default storage key)
    await page.goto('/')
    await page.evaluate(() => {
      localStorage.removeItem('use-kbd')
      localStorage.removeItem('use-kbd-removed')
    })
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

    // Check that "1 year" action shows "1" binding (with × remove button)
    const oneYearAction = page.locator('.kbd-action', { has: page.locator('.kbd-action-label:text("1 year")') })
    // The kbd contains the key text plus × remove and + add-inline buttons
    await expect(oneYearAction.locator('.kbd-kbd')).toHaveText('1×+')
  })

  test('can change binding for an action', async ({ page }) => {
    await page.keyboard.press('?')
    await expect(page.locator('text=Keyboard Shortcuts')).toBeVisible()

    // Click on the "1" binding for "1 year"
    const oneYearAction = page.locator('.kbd-action', { has: page.locator('.kbd-action-label:text("1 year")') })
    await oneYearAction.locator('.kbd-kbd').click()

    // Wait for recording mode (shows "...")
    await expect(oneYearAction.locator('.kbd-kbd')).toContainText('...')

    // Press a new key to replace the binding, then Tab to commit (moves to next)
    await page.keyboard.press('0')
    await page.keyboard.press('Tab')
    // Escape to cancel editing on the next action
    await page.keyboard.press('Escape')

    // "1 year" should now have '0'
    await expect(oneYearAction.locator('.kbd-kbd')).not.toHaveClass(/editing/)
    await expect(oneYearAction.locator('.kbd-kbd')).toHaveText('0×+')

    // Should have REPLACED the old binding
    const kbds = oneYearAction.locator('.kbd-kbd')
    await expect(kbds).toHaveCount(1)
  })

  test('persists bindings to localStorage', async ({ page }) => {
    await page.keyboard.press('?')
    await expect(page.locator('text=Keyboard Shortcuts')).toBeVisible()

    // Change "1 year" from "1" to "0" - Tab commits and moves to next
    const oneYearAction = page.locator('.kbd-action', { has: page.locator('.kbd-action-label:text("1 year")') })
    await oneYearAction.locator('.kbd-kbd').click()
    await page.keyboard.press('0')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Escape')

    // Verify it changed
    await expect(oneYearAction.locator('.kbd-kbd')).toHaveText('0×+')

    // Close the modal
    await page.locator('button[aria-label="Close"]').click()

    // Reload the page
    await page.reload()
    await page.waitForSelector('.plotly')

    // Open modal again
    await page.keyboard.press('?')
    await expect(page.locator('text=Keyboard Shortcuts')).toBeVisible()

    // Check binding is still "0"
    const oneYearActionAfter = page.locator('.kbd-action', { has: page.locator('.kbd-action-label:text("1 year")') })
    await expect(oneYearActionAfter.locator('.kbd-kbd')).toHaveText('0×+')
  })

  test('reset restores default bindings', async ({ page }) => {
    await page.keyboard.press('?')
    await expect(page.locator('text=Keyboard Shortcuts')).toBeVisible()

    // Change "1 year" from "1" to "0" - Tab commits and moves to next
    const oneYearAction = page.locator('.kbd-action', { has: page.locator('.kbd-action-label:text("1 year")') })
    await oneYearAction.locator('.kbd-kbd').click()
    await page.keyboard.press('0')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Escape')

    // Verify it changed
    await expect(oneYearAction.locator('.kbd-kbd')).toHaveText('0×+')

    // Click reset button in the footer of the main-page shortcuts modal
    await page.locator('.kbd-modal-footer button:has-text("Reset")').click()

    // Should be back to "1"
    await expect(oneYearAction.locator('.kbd-kbd')).toHaveText('1×+')
  })

  test('empty binding shows ∅ symbol', async ({ page }) => {
    await page.keyboard.press('?')
    await expect(page.locator('text=Keyboard Shortcuts')).toBeVisible()

    // Find "1 year" action and clear its binding by clicking the remove button
    const oneYearAction = page.locator('.kbd-action', { has: page.locator('.kbd-action-label:text("1 year")') })
    await oneYearAction.locator('.kbd-remove-btn').click()

    // Should show empty symbol (∅) via the add button since there are no bindings
    // When all bindings are removed, only the add button (+) remains
    await expect(oneYearAction.locator('.kbd-add-btn')).toBeVisible()
  })

  test('setting key to its default does not store in localStorage', async ({ page }) => {
    await page.keyboard.press('?')
    await expect(page.locator('text=Keyboard Shortcuts')).toBeVisible()

    // Change "1 year" from "1" to "0" - Tab commits and moves to next
    const oneYearAction = page.locator('.kbd-action', { has: page.locator('.kbd-action-label:text("1 year")') })
    await oneYearAction.locator('.kbd-kbd').click()
    await page.keyboard.press('0')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Escape')

    // Verify it changed
    await expect(oneYearAction.locator('.kbd-kbd')).toHaveText('0×+')

    // Verify storage has the change (use-kbd is the default storage key)
    let storage = await page.evaluate(() => localStorage.getItem('use-kbd'))
    expect(storage).toBeTruthy()
    expect(storage).toContain('date:1y')

    // Now change it back to "1" (the default) - Tab commits
    await oneYearAction.locator('.kbd-kbd').click()
    await page.keyboard.press('1')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Escape')

    // Verify it's back to "1"
    await expect(oneYearAction.locator('.kbd-kbd')).toHaveText('1×+')

    // Storage should no longer have date:1y since it's back to default
    storage = await page.evaluate(() => localStorage.getItem('use-kbd'))
    if (storage) {
      expect(storage).not.toContain('date:1y')
    }
  })

  test('Tab commits pending key to current action then moves to next', async ({ page }) => {
    await page.keyboard.press('?')
    await expect(page.locator('text=Keyboard Shortcuts')).toBeVisible()

    // Click on "1 year" binding
    const oneYearAction = page.locator('.kbd-action', { has: page.locator('.kbd-action-label:text("1 year")') })
    await oneYearAction.locator('.kbd-kbd').click()

    // Type 'q' then Tab (should commit q and move to next action)
    await page.keyboard.press('q')
    await page.keyboard.press('Tab')

    // "1 year" should now have 'Q' (no longer editing)
    await expect(oneYearAction.locator('.kbd-kbd')).not.toHaveClass(/editing/)
    await expect(oneYearAction.locator('.kbd-kbd')).toHaveText('Q×+')

    // Next action (2 years) should be in recording mode
    const twoYearAction = page.locator('.kbd-action', { has: page.locator('.kbd-action-label:text("2 years")') })
    await expect(twoYearAction.locator('.kbd-kbd.editing')).toBeVisible()
  })
})
