import { defineConfig, devices } from '@playwright/test'

// `BASE_URL=http://localhost:<port>` targets another dev server (e.g. a
// worktree's) instead of starting/reusing the default one on 3456.
const baseURL = process.env.BASE_URL ?? 'http://localhost:3456'

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['**/bundle.spec.ts'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm dev',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
})
