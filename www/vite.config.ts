import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import mdx from '@mdx-js/rollup'

export default defineConfig({
  plugins: [
    { enforce: 'pre', ...mdx() },
    react(),
  ],
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  build: {
    outDir: 'dist',
  },
  // Pre-bundle the heavy deck.gl/maplibre deps at server start, so the first
  // load of the GL map doesn't trigger a mid-flight "optimized dependencies
  // changed, reloading" (which races the initial data fetch). Mirrors jc-taxes.
  optimizeDeps: {
    include: ['@deck.gl/core', '@deck.gl/layers', '@deck.gl/react', 'react-map-gl/maplibre', 'maplibre-gl'],
  },
  server: {
    port: 3456,
    strictPort: true,
    host: true,
    allowedHosts: true,  // trusted-tailnet dev server, reached by bare MagicDNS name (e.g. `m3:3456`)
  }
})
