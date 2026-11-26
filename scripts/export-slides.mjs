// 発表スライド（slides.html）を PDF と PowerPoint（画像＋スピーカーノート）に書き出す
//   npm run slides:export
// 必要なもの: Microsoft Edge（Windows に標準で入っている）
// 出力先: Sorana発表資料/SolGPU_発表資料.{pdf,pptx}（日本語）と SolGPU_Slides_EN.{pdf,pptx}（英語）
import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import pptxgen from 'pptxgenjs'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'Sorana発表資料')
mkdirSync(outDir, { recursive: true })

const server = await createServer({ root, server: { port: 5197, strictPort: true } })
await server.listen()
const browser = await chromium.launch({ channel: 'msedge' })
const allNotes = JSON.parse(readFileSync(path.join(root, 'src/slides/notes.json'), 'utf8'))
const OUTPUTS = [
  { lang: 'ja', name: 'SolGPU_発表資料', sec: (n) => `【${n}秒】\n` },
  { lang: 'en', name: 'SolGPU_Slides_EN', sec: (n) => `[${n} sec]\n` },
]
try {
  for (const out of OUTPUTS) {
    const shots = mkdtempSync(path.join(tmpdir(), `solgpu-slides-${out.lang}-`))
    const page = await (
      await browser.newContext({ viewport: { width: 800, height: 450 }, deviceScaleFactor: 2.4, colorScheme: 'dark' })
    ).newPage()
    await page.goto(`http://localhost:5197/slides.html?export=1&lang=${out.lang}`, { waitUntil: 'load', timeout: 120_000 })
    await page.waitForSelector('article', { timeout: 120_000 })
    // テーマのフォントと画像が届くまで待つ（届く前に撮ると代替フォントで写る）
    await page.waitForTimeout(1500)
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate(() => Promise.all([...document.images].map((im) => im.decode().catch(() => {}))))
    await page.waitForTimeout(500)

    const slides = page.locator('article')
    const n = await slides.count()
    for (let i = 0; i < n; i++) {
      // 枠からはみ出している文字があれば知らせる
      const overflow = await slides.nth(i).evaluate((el) => {
        const box = el.getBoundingClientRect()
        return [...el.querySelectorAll('*')].filter((c) => {
          const r = c.getBoundingClientRect()
          return r.width > 0 && (r.bottom > box.bottom + 1 || r.right > box.right + 1)
        }).length
      })
      if (overflow) console.warn(`⚠ [${out.lang}] ${i + 1} 枚目: 枠からはみ出している要素が ${overflow} 個あります`)
      await slides.nth(i).screenshot({ path: path.join(shots, `slide${String(i + 1).padStart(2, '0')}.png`) })
    }
    await page.pdf({
      path: path.join(outDir, `${out.name}.pdf`),
      width: '800px',
      height: '450px',
      printBackground: true,
      margin: { top: 0, bottom: 0, left: 0, right: 0 },
    })

    const notes = allNotes[out.lang]
    const pptx = new pptxgen()
    pptx.layout = 'LAYOUT_WIDE'
    readdirSync(shots)
      .filter((f) => f.endsWith('.png'))
      .sort()
      .forEach((f, i) => {
        const s = pptx.addSlide()
        s.addImage({ path: path.join(shots, f), x: 0, y: 0, w: 13.333, h: 7.5 })
        const note = notes[i]
        if (note) s.addNotes((note.seconds ? out.sec(note.seconds) : '') + note.script)
      })
    await pptx.writeFile({ fileName: path.join(outDir, `${out.name}.pptx`) })
    console.log(`[${out.lang}] ${n} 枚を書き出しました: ${shots} → ${out.name}.pdf / .pptx`)
  }
} finally {
  await browser.close()
  await server.close()
}
