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
  server: {
    port: 3456,
    strictPort: true,
    host: true,
    allowedHosts: true,  // trusted-tailnet dev server, reached by bare MagicDNS name (e.g. `m3:3456`)
  }
})
