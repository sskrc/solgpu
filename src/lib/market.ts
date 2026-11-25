import { PublicKey } from '@solana/web3.js'
import { fetchListings, type Listing } from './program'
import { connection } from './solana'

// ===== 貸し手エージェントとの通信 =====
export type AgentInfo = {
  sorana: string
  programId: string
  agentUrl: string
  gpu: string
  backend: string
  dtype: string
  tflops: number
  lamportsPerMinute: number
  operator: string
  operatorBalance: number | null
  listing: string | null
  owner: string | null
  busy: boolean
  maxMinutes: number
}

export type SessionInfo = {
  status: 'starting' | 'ready' | 'ended' | 'error'
  error: string
  url: string
  minutes: number
  expiresAt: number
  settleSignature: string
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
  checkCode: (base: string, code: string) => call<{ ok: boolean }>(base, '/check-code', { code }, 10_000),
  activate: (base: string, listing: string, code: string) => call<AgentInfo>(base, '/activate', { listing, code }),
  claim: (base: string, rental: string, secret: string) => call<SessionInfo>(base, '/claim', { rental, secret }),
  session: (base: string, rental: string, secret: string) => call<SessionInfo>(base, '/session', { rental, secret }),
}

// ===== マーケットの一覧（オンチェーンの出品 + エージェントの生存確認）=====
export type MarketItem = { listing: Listing; info: AgentInfo }

/**
 * SolGPU プログラムの出品アカウントを読み、受付中のものに問い合わせて、
 * 「オンライン」かつ「エージェント自身がその出品に紐付いていると答えた」ものだけを返す
 * （他人のエージェントの URL を勝手に出品しても表示されない）
 */
export async function loadMarket(): Promise<MarketItem[]> {
  const listings = (await fetchListings(connection)).filter((l) => l.active)
  const items = await Promise.all(
    listings.map(async (listing) => {
      try {
        const info = await agentApi.info(listing.agentUrl, 4_000)
        if (info.listing === listing.address.toBase58() && info.operator === listing.operator.toBase58()) {
          return { listing, info }
        }
      } catch {
        /* オフライン */
      }
      return null
    }),
  )
  return items.filter((x): x is MarketItem => x !== null)
}

// ===== 借りたレンタルの記録（このブラウザに保存）=====
export type SavedRental = {
  rental: string
  listing: string
  agentUrl: string
  gpu: string
  minutes: number
  lamports: number
  secret: string
  createdAt: number
  paid?: boolean
}

const KEY = 'sorana:rentals:v2'
export function loadRentals(): SavedRental[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as SavedRental[]
  } catch {
    return []
  }
}
export function saveRental(r: SavedRental) {
  const all = loadRentals().filter((x) => x.rental !== r.rental)
  try {
    localStorage.setItem(KEY, JSON.stringify([r, ...all].slice(0, 50)))
  } catch {
    /* 保存できない環境 */
  }
}

export async function sha256(text: string) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

export function randomSecret() {
  const b = crypto.getRandomValues(new Uint8Array(24))
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

export const toKey = (s: string) => new PublicKey(s)
