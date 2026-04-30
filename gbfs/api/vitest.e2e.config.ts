import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/**/*.e2e.test.ts'],
		// Live network calls are slow; default 5s timeout is too tight.
		testTimeout: 30_000,
	},
});
