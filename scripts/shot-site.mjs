// 公開中のサイト（GitHub Pages）の「GPU を借りる」画面を撮って、スライド 4 枚目の画像にする
//   npm run slides:shot   → src/slides/site.png（そのあと npm run slides:export）
// V100 などが出品されてオンラインのときに撮ると、一覧に GPU が並んだ画面になる
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'src/slides/site.png')
const browser = await chromium.launch({ channel: 'msedge' })
try {
  const page = await (
    await browser.newContext({ viewport: { width: 1120, height: 700 }, deviceScaleFactor: 2, colorScheme: 'dark' })
  ).newPage()
  await page.goto('https://sskrc.github.io/solgpu/', { waitUntil: 'networkidle', timeout: 90_000 })
  // 出品一覧（各貸し手エージェントへの問い合わせ）が出そろうまで待つ
  await page.waitForTimeout(8000)
  await page.screenshot({ path: out })
  console.log('保存しました:', out)
} finally {
  await browser.close()
}
