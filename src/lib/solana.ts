import {
  clusterApiUrl,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'
import { Buffer } from 'buffer'
import type { PhantomProvider } from '../phantom'
import { programErrorMessage } from './program'

// このアプリは Devnet 専用。接続先を固定しているので、Phantom の設定に関係なく Devnet に送信されます
export const NETWORK = 'devnet'
// ローカルの validator で試すときは .env.local に VITE_RPC_URL=http://127.0.0.1:8899 と書く
const CUSTOM_RPC = import.meta.env.VITE_RPC_URL as string | undefined
export const connection = new Connection(CUSTOM_RPC || clusterApiUrl(NETWORK), 'confirmed')
export const explorer = (path: string) =>
  CUSTOM_RPC
    ? `https://explorer.solana.com/${path}?cluster=custom&customUrl=${encodeURIComponent(CUSTOM_RPC)}`
    : `https://explorer.solana.com/${path}?cluster=${NETWORK}`

export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
export const FEE_BUFFER_LAMPORTS = 10_000

/** 性能から出す目安の価格（エージェントと同じ）: 計測 TFLOPS × 2,000 lamports / 分、最低 10,000 lamports / 分 */
export const LAMPORTS_PER_TFLOPS_MINUTE = 2_000
export const MIN_LAMPORTS_PER_MINUTE = 10_000
/** プログラムが受け付ける価格の上限（1 SOL / 分） */
export const MAX_LAMPORTS_PER_MINUTE = 1_000_000_000

/** 目安の誤差（TFLOPS を 0.01 単位に丸めることによる最大のずれ） */
const REFERENCE_TOLERANCE_LAMPORTS = LAMPORTS_PER_TFLOPS_MINUTE * 0.005

/** 性能（TFLOPS）から算出した 1 分あたりの目安の価格 */
export const referencePrice = (tflops: number) =>
  Math.max(MIN_LAMPORTS_PER_MINUTE, Math.round(tflops * LAMPORTS_PER_TFLOPS_MINUTE))

/** 入力された「SOL / 分」を lamports にする。範囲外・不正なら理由を返す */
export function parsePrice(input: string): { lamports: number } | { error: string } {
  const sol = Number(input)
  if (!input.trim() || !Number.isFinite(sol) || sol <= 0) return { error: '価格を SOL で入力してください。' }
  const lamports = Math.round(sol * LAMPORTS_PER_SOL)
  if (lamports < MIN_LAMPORTS_PER_MINUTE || lamports > MAX_LAMPORTS_PER_MINUTE)
    return {
      error: `価格は ${lamportsToSol(MIN_LAMPORTS_PER_MINUTE)}〜${lamportsToSol(MAX_LAMPORTS_PER_MINUTE)} SOL / 分の範囲で入力してください。`,
    }
  return { lamports }
}

export const shorten = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`
/** SOL の表示（最大 9 桁。指数表記にしない） */
export const formatSol = (n: number) => n.toFixed(9).replace(/\.?0+$/, '')
export const lamportsToSol = (l: number) => formatSol(l / LAMPORTS_PER_SOL)

/** 価格が目安と比べていくら高い・安いか（例：「目安より 0.00001 SOL 高い（+38%）」） */
export function priceDiffLabel(price: number, reference: number) {
  const diff = price - reference
  // 性能はチェーン上で小数第 2 位に丸めて保存されるので、目安には最大 10 lamports の誤差がある
  if (Math.abs(diff) <= REFERENCE_TOLERANCE_LAMPORTS) return '目安どおり'
  const pct = Math.round((Math.abs(diff) / reference) * 100)
  const rate = pct < 1 ? '1% 未満' : `${diff > 0 ? '+' : '−'}${pct}%`
  return `目安より ${lamportsToSol(Math.abs(diff))} SOL ${diff > 0 ? '高い' : '安い'}（${rate}）`
}

export function memoIx(signer: PublicKey, text: string) {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(text, 'utf8'),
  })
}

/** 送信後に確認だけ失敗した場合のエラー（送金自体は成功している可能性がある） */
export class SentButUnconfirmedError extends Error {
  signature: string
  cause: unknown
  constructor(signature: string, cause: unknown) {
    super('sent but unconfirmed')
    this.signature = signature
    this.cause = cause
  }
}

/**
 * Phantom で署名 → Devnet に送信 → 確定まで待つ、の共通処理
 * onStep で進捗メッセージを画面に出せます
 */
export async function signAndSend(
  phantom: PhantomProvider,
  payer: PublicKey,
  instructions: TransactionInstruction[],
  onStep: (msg: string) => void,
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight }).add(...instructions)

  onStep('Phantom で内容を確認し、「承認」を押してください…')
  const signed = await phantom.signTransaction(tx)

  onStep('Devnet に送信しています…')
  const signature = await connection.sendRawTransaction(signed.serialize())

  onStep('承認（コンファーム）を待っています…')
  try {
    const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
    if (result.value.err) throw new Error(`トランザクションが失敗しました: ${JSON.stringify(result.value.err)}`)
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('トランザクションが失敗')) throw err
    throw new SentButUnconfirmedError(signature, err)
  }
  return signature
}

/** 送金先が未使用アカウントの場合に必要な最低額をチェック */
export async function checkRentForRecipient(to: PublicKey, lamports: number): Promise<string | null> {
  const [info, rentMin] = await Promise.all([
    connection.getAccountInfo(to),
    connection.getMinimumBalanceForRentExemption(0),
  ])
  if (!info && lamports < rentMin) {
    return `送金先はまだ使われていないアドレスです。最低 ${lamportsToSol(rentMin)} SOL 以上を送ってください。`
  }
  return null
}

export function transferIx(from: PublicKey, to: PublicKey, lamports: number) {
  return SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports })
}

export type FriendlyError = { message: string; detail?: string; signature?: string }

/** エラーを初心者にも分かる日本語に変換する */
export function toFriendlyError(err: unknown): FriendlyError {
  if (err instanceof SentButUnconfirmedError) {
    return {
      message: '送信済みですが、完了を確認できませんでした。再実行する前に Explorer で結果を確認してください（二重送金の防止）。',
      detail: String((err.cause as Error)?.message ?? err.cause),
      signature: err.signature,
    }
  }
  const e = err as { code?: number; message?: string; logs?: string[] }
  const raw = [e?.message ?? String(err), ...(e?.logs ?? [])].join('\n')
  if (/program that does not exist|Unsupported program id|ProgramAccountNotFound/i.test(raw)) {
    return {
      message: 'SolGPU プログラムがまだこのネットワーク（Devnet）にデプロイされていません。デプロイが完了するまで出品・レンタルはできません。',
      detail: raw,
    }
  }
  const programMsg = programErrorMessage(raw)
  if (programMsg) return { message: programMsg, detail: raw }
  if (e?.code === 4001 || /user rejected|reject|cancel|denied/i.test(raw)) {
    return { message: 'ウォレットで承認がキャンセルされました。', detail: raw }
  }
  if (/429|too many requests|rate limit/i.test(raw)) {
    return { message: 'Devnet の RPC が混雑しています（リクエスト制限）。少し待ってから再試行してください。', detail: raw }
  }
  if (/insufficient funds for rent/i.test(raw)) {
    return {
      message:
        '残高の条件を満たしていません。送金先が未使用のアドレスなら約 0.001 SOL 以上を送るか、送金後の自分の残高が少なくなりすぎないよう金額を減らしてください。',
      detail: raw,
    }
  }
  if (/insufficient (funds|lamports)|no record of a prior credit|0x1\b/i.test(raw)) {
    return { message: '残高が足りません。Faucet で Devnet の SOL を入手してください。', detail: raw }
  }
  if (/block height exceeded|expired|blockhash not found/i.test(raw)) {
    return { message: 'トランザクションの有効期限が切れました。もう一度お試しください。', detail: raw }
  }
  if (/failed to fetch|networkerror|load failed/i.test(raw)) {
    return { message: '接続できませんでした。インターネット接続、または貸し手のエージェントが起動しているか確認してください。', detail: raw }
  }
  return { message: raw.length < 200 ? raw : '処理に失敗しました。', detail: raw }
}

export { LAMPORTS_PER_SOL, PublicKey }
