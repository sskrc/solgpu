import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// base: './' にすると、GitHub Pages のリポジトリ名に関係なく動きます
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 1000,
  },
  define: {
    global: 'globalThis',
  },
})
