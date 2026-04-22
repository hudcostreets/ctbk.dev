import { defineConfig, devices } from '@playwright/test'

/**
 * Separate Playwright config for bundle-size assertions. Runs a production
 * `vite build` + `vite preview` so we measure the real shipped artifacts
 * (chunking, minification, gzip), not dev-server transforms.
 *
 *   pnpm test:bundle
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: ['**/bundle.spec.ts'],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4173',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm build && pnpm exec vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
