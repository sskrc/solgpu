// @solana/web3.js はブラウザに無い Buffer を使うため、他のモジュールより先に用意します
import { Buffer } from 'buffer'

const g = globalThis as unknown as { Buffer?: typeof Buffer }
if (!g.Buffer) g.Buffer = Buffer
