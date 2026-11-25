import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// base: './' にすると、GitHub Pages のリポジトリ名に関係なく動きます
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    // 発表スライド（slides.html）は公開ビルドに含めない（npm run dev と npm run slides:export でだけ使う）
    chunkSizeWarningLimit: 1600,
  },
  define: {
    global: 'globalThis',
  },
})
