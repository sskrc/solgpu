import type { ParsedTransactionWithMeta } from '@solana/web3.js'
import { connection, MEMO_PROGRAM_ID, REGISTRY } from './solana'

// ===== 貸し手エージェントとの通信 =====
export type AgentInfo = {
  sorana: string
  agentUrl: string
  gpu: string
  backend: string
  dtype: string
  tflops: number
  lamportsPerMinute: number
  payout: string | null
  busy: boolean
  busyUntil: number
  maxMinutes: number
}

export type SessionInfo = {
  status: 'starting' | 'ready' | 'ended' | 'error'
  error: string
  url: string
  minutes: number
  expiresAt: number
  now: number
}

async function call<T>(base: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(base.replace(/\/$/, '') + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error ?? `エージェントがエラーを返しました (${res.status})`)
    return data as T
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new Error('エージェントからの応答がタイムアウトしました')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export const agentApi = {
  info: (base: string, timeoutMs = 5_000) => call<AgentInfo>(base, '/info', undefined, timeoutMs),
  activate: (base: string, signature: string, code: string) => call<AgentInfo>(base, '/activate', { signature, code }),
  reserve: (base: string, renter: string) =>
    call<{ reservationId: string; expiresAt: number; payout: string; lamportsPerMinute: number }>(base, '/reserve', { renter }),
  claim: (base: string, signature: string, secret: string) => call<SessionInfo>(base, '/claim', { signature, secret }),
  session: (base: string, signature: string, secret: string) => call<SessionInfo>(base, '/session', { signature, secret }),
}

// ===== メモの形式 =====
/** 出品メモには認証コードそのものではなくハッシュだけを書く（コードはエージェントに直接送る） */
export const listMemo = (agent: string, codeHash: string) => `sorana:v1:list:${JSON.stringify({ agent, codeHash })}`
export const rentMemo = (r: string, m: number, h: string) => `sorana:v1:rent:${JSON.stringify({ r, m, h })}`

// ===== オンチェーンの出品一覧を読む =====
export type Listing = { agentUrl: string; lister: string; signature: string; time: number; info: AgentInfo | null }

function memoOf(tx: ParsedTransactionWithMeta): string | null {
  for (const ix of tx.transaction.message.instructions) {
    if (ix.programId.equals(MEMO_PROGRAM_ID) && 'parsed' in ix && typeof ix.parsed === 'string') return ix.parsed
  }
  return null
}

/**
 * REGISTRY アドレスの履歴から出品メモを集め、各エージェントに問い合わせて
 * 「オンライン」かつ「出品者と受取アドレスが一致する」ものだけを返す
 */
export async function loadListings(limit = 40): Promise<Listing[]> {
  const sigs = await connection.getSignaturesForAddress(REGISTRY, { limit })
  const ok = sigs.filter((s) => !s.err).map((s) => s.signature)
  if (ok.length === 0) return []
  const txs = await connection.getParsedTransactions(ok, { maxSupportedTransactionVersion: 0 })

  const latestByAgent = new Map<string, Listing>()
  txs.forEach((tx, i) => {
    if (!tx || tx.meta?.err) return
    const memo = memoOf(tx)
    if (!memo?.startsWith('sorana:v1:list:')) return
    try {
      const { agent } = JSON.parse(memo.slice('sorana:v1:list:'.length)) as { agent: string }
      if (typeof agent !== 'string' || !/^https?:\/\//.test(agent)) return
      const lister = tx.transaction.message.accountKeys[0].pubkey.toBase58()
      if (!latestByAgent.has(agent)) {
        // getSignaturesForAddress は新しい順なので、最初に見つかったものが最新
        latestByAgent.set(agent, { agentUrl: agent, lister, signature: ok[i], time: tx.blockTime ?? 0, info: null })
      }
    } catch {
      /* 壊れたメモは無視 */
    }
  })

  const listings = [...latestByAgent.values()]
  await Promise.all(
    listings.map(async (l) => {
      try {
        const info = await agentApi.info(l.agentUrl, 4_000)
        // 他人のエージェントを勝手に出品できないよう、エージェント自身が認識している受取アドレスと照合
        if (info.payout === l.lister && info.agentUrl === l.agentUrl) l.info = info
      } catch {
        /* オフライン */
      }
    }),
  )
  return listings.filter((l) => l.info)
}

// ===== 借りたレンタルの記録（このブラウザに保存）=====
export type Rental = {
  agentUrl: string
  gpu: string
  minutes: number
  lamports: number
  secret: string
  reservationId: string
  signature?: string
  createdAt: number
}

const KEY = 'sorana:rentals'
export function loadRentals(): Rental[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as Rental[]
  } catch {
    return []
  }
}
export function saveRental(r: Rental) {
  const all = loadRentals().filter((x) => !(x.reservationId === r.reservationId && x.agentUrl === r.agentUrl))
  try {
    localStorage.setItem(KEY, JSON.stringify([r, ...all].slice(0, 50)))
  } catch {
    /* 保存できない環境 */
  }
}

export async function sha256Hex(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function randomSecret() {
  const b = crypto.getRandomValues(new Uint8Array(24))
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}
