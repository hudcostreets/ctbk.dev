import { defineConfig } from 'vitest/config'

// Unit tests for pure modules only (`src/**/*.test.ts`); Playwright owns
// `e2e/*.spec.ts`, which vitest's default glob would otherwise pick up.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
