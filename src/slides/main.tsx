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
// ?lang=en で英語版のみ、?lang=ja で日本語版のみ。指定なしは日本語版のあとに英語版（書き出しと同じ）
const only = params.get('lang')
const langs: Lang[] = only === 'en' ? ['en'] : only === 'ja' ? ['ja'] : ['ja', 'en']

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Theme theme={themes[defaultThemeSlug]} mode={themeModes[defaultThemeSlug] ?? 'system'}>
      {isExport ? (
        <VStack gap={0}>
          {langs.map((l) => (
            <Deck key={l} lang={l} />
          ))}
        </VStack>
      ) : (
        <Center axis="horizontal" padding={8}>
          <VStack gap={8}>
            {langs.map((l) => (
              <Deck key={l} lang={l} />
            ))}
          </VStack>
        </Center>
      )}
    </Theme>
  </StrictMode>,
)
