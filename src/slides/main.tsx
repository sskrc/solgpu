import '@astryxdesign/core/reset.css'
import '@astryxdesign/core/astryx.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Center } from '@astryxdesign/core/Center'
import { Theme } from '@astryxdesign/core/theme'
import { VStack } from '@astryxdesign/core/VStack'
import { defaultThemeSlug, themeModes, themes } from '../astryx-themes'
import { Deck, type Lang } from './Deck'

// ?export=1 のときは余白なしで縦に並べる（書き出し用）
const params = new URLSearchParams(location.search)
const isExport = params.has('export')
// ?lang=en で英語版
const lang: Lang = params.get('lang') === 'en' ? 'en' : 'ja'
document.documentElement.lang = lang

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Theme theme={themes[defaultThemeSlug]} mode={themeModes[defaultThemeSlug] ?? 'system'}>
      {isExport ? (
        <VStack gap={0}>
          <Deck lang={lang} />
        </VStack>
      ) : (
        <Center axis="horizontal" padding={8}>
          <VStack gap={8}>
            <Deck lang={lang} />
          </VStack>
        </Center>
      )}
    </Theme>
  </StrictMode>,
)
