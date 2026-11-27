// 発表スライド（slides.html）を PDF と PowerPoint（画像＋スピーカーノート）に書き出す
//   npm run slides:export
// 必要なもの: Microsoft Edge（Windows に標準で入っている）
// 出力先: Sorana発表資料/SolGPU_発表資料.{pdf,pptx}（日本語版のあとに英語版を続けた 1 つのファイル）
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import pptxgen from 'pptxgenjs'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'Sorana発表資料')
const NAME = 'SolGPU_発表資料'
const shots = mkdtempSync(path.join(tmpdir(), 'solgpu-slides-'))
mkdirSync(outDir, { recursive: true })

// スライドの並び（main.tsx の既定と同じ：日本語 → 英語）に合わせてノートを並べる
const allNotes = JSON.parse(readFileSync(path.join(root, 'src/slides/notes.json'), 'utf8'))
const notes = [
  ...allNotes.ja.map((n) => ({ ...n, head: n.seconds ? `【${n.seconds}秒】\n` : '' })),
  ...allNotes.en.map((n) => ({ ...n, head: n.seconds ? `[${n.seconds} sec]\n` : '' })),
]

const server = await createServer({ root, server: { port: 5197, strictPort: true } })
await server.listen()
const browser = await chromium.launch({ channel: 'msedge' })
try {
  const page = await (
    await browser.newContext({ viewport: { width: 800, height: 450 }, deviceScaleFactor: 2.4, colorScheme: 'dark' })
  ).newPage()
  // テーマのフォントは font-display: fallback。初回（開発サーバーの準備中）は届くのが遅れて
  // 代替フォントのまま固定されることがあるので、一度読み込んでから開き直す
  for (let i = 0; i < 2; i++) {
    await page.goto('http://localhost:5197/slides.html?export=1', { waitUntil: 'load', timeout: 120_000 })
    await page.waitForSelector('article', { timeout: 120_000 })
    await page.waitForTimeout(1500)
    await page.evaluate(() => document.fonts.ready)
  }
  const fontOk = await page.evaluate(() => document.fonts.check('600 24px Fustat'))
  if (!fontOk) throw new Error('テーマのフォント（Fustat）が読み込めていません。もう一度実行してください')
  await page.waitForTimeout(500)

  const slides = page.locator('article')
  const n = await slides.count()
  if (n !== notes.length) console.warn(`⚠ スライド ${n} 枚に対して原稿が ${notes.length} 件あります`)
  const files = []
  for (let i = 0; i < n; i++) {
    // 枠からはみ出している文字があれば知らせる
    const overflow = await slides.nth(i).evaluate((el) => {
      const box = el.getBoundingClientRect()
      return [...el.querySelectorAll('*')].filter((c) => {
        const r = c.getBoundingClientRect()
        return r.width > 0 && (r.bottom > box.bottom + 1 || r.right > box.right + 1)
      }).length
    })
    if (overflow) console.warn(`⚠ ${i + 1} 枚目: 枠からはみ出している要素が ${overflow} 個あります`)
    const file = path.join(shots, `slide${String(i + 1).padStart(2, '0')}.png`)
    await slides.nth(i).screenshot({ path: file })
    files.push(file)
  }
  await page.pdf({
    path: path.join(outDir, `${NAME}.pdf`),
    width: '800px',
    height: '450px',
    printBackground: true,
    margin: { top: 0, bottom: 0, left: 0, right: 0 },
  })

  const pptx = new pptxgen()
  pptx.layout = 'LAYOUT_WIDE'
  files.forEach((file, i) => {
    const s = pptx.addSlide()
    s.addImage({ path: file, x: 0, y: 0, w: 13.333, h: 7.5 })
    const note = notes[i]
    if (note) s.addNotes(note.head + note.script)
  })
  await pptx.writeFile({ fileName: path.join(outDir, `${NAME}.pptx`) })
  console.log(`${n} 枚を書き出しました: ${shots} → ${NAME}.pdf / .pptx`)
} finally {
  await browser.close()
  await server.close()
}
