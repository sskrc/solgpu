import './polyfills' // 必ず一番最初に読み込む
import '@astryxdesign/core/reset.css'
import '@astryxdesign/core/astryx.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Theme } from '@astryxdesign/core/theme'
import { defaultThemeSlug, themeModes, themes } from './astryx-themes'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Theme theme={themes[defaultThemeSlug]} mode={themeModes[defaultThemeSlug] ?? 'system'}>
      <App />
    </Theme>
  </StrictMode>,
)
