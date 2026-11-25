/**
 * SolGPU プログラム（Anchor）とのやり取り
 * ブラウザとテストスクリプトの両方から使えるよう、Connection は引数で受け取る
 */
import { BN, BorshAccountsCoder, BorshInstructionCoder, type Idl } from '@anchor-lang/core'
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from '@solana/web3.js'
import idlJson from '../idl/solgpu_market.json' with { type: 'json' }

export const IDL = idlJson as unknown as Idl
export const PROGRAM_ID = new PublicKey(IDL.address)
const accountsCoder = new BorshAccountsCoder(IDL)
const ixCoder = new BorshInstructionCoder(IDL)

export type Listing = {
  address: PublicKey
  owner: PublicKey
  operator: PublicKey
  listingId: bigint
  agentUrl: string
  gpu: string
  tflops: number
  lamportsPerMinute: number
  active: boolean
  busyUntil: number
  currentRental: PublicKey
  openRentals: number
  totalRentals: number
}

export type Rental = {
  address: PublicKey
  listing: PublicKey
  renter: PublicKey
  owner: PublicKey
  minutes: number
  amount: number
  secretHash: Uint8Array
  status: 'Pending' | 'Active'
  createdAt: number
  acceptDeadline: number
  startedAt: number
  endsAt: number
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const num = (x: any) => (BN.isBN(x) ? Number(x.toString()) : Number(x))

function toListing(address: PublicKey, d: any): Listing {
  return {
    address,
    owner: d.owner,
    operator: d.operator,
    listingId: BigInt(d.listing_id.toString()),
    agentUrl: d.agent_url,
    gpu: d.gpu,
    tflops: d.tflops_x100 / 100,
    lamportsPerMinute: num(d.lamports_per_minute),
    active: d.active,
    busyUntil: num(d.busy_until),
    currentRental: d.current_rental,
    openRentals: d.open_rentals,
    totalRentals: num(d.total_rentals),
  }
}

function toRental(address: PublicKey, d: any): Rental {
  return {
    address,
    listing: d.listing,
    renter: d.renter,
    owner: d.owner,
    minutes: d.minutes,
    amount: num(d.amount),
    secretHash: Uint8Array.from(d.secret_hash),
    status: 'Pending' in d.status || 'pending' in d.status ? 'Pending' : 'Active',
    createdAt: num(d.created_at),
    acceptDeadline: num(d.accept_deadline),
    startedAt: num(d.started_at),
    endsAt: num(d.ends_at),
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------- アドレス (PDA)
const u64le = (n: bigint) => {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, n, true)
  return b
}
const enc = (s: string) => new TextEncoder().encode(s)

export const listingPda = (owner: PublicKey, listingId: bigint) =>
  PublicKey.findProgramAddressSync([enc('listing'), owner.toBytes(), u64le(listingId)], PROGRAM_ID)[0]

export const rentalPda = (listing: PublicKey, renter: PublicKey, nonce: bigint) =>
  PublicKey.findProgramAddressSync([enc('rental'), listing.toBytes(), renter.toBytes(), u64le(nonce)], PROGRAM_ID)[0]

/** 0〜2^53 のランダムな ID（出品 ID・レンタルの nonce 用） */
export const randomU64 = () => {
  const b = crypto.getRandomValues(new Uint8Array(8))
  b[6] &= 0x1f
  b[7] = 0
  return new DataView(b.buffer).getBigUint64(0, true)
}

// ---------------------------------------------------------------- 読み取り
export async function fetchListings(connection: Connection, owner?: PublicKey): Promise<Listing[]> {
  const filters: { memcmp: { offset: number; bytes: string } }[] = [
    { memcmp: { offset: 0, bytes: accountsCoder.memcmp('Listing').bytes as string } },
  ]
  if (owner) filters.push({ memcmp: { offset: 8, bytes: owner.toBase58() } })
  const res = await connection.getProgramAccounts(PROGRAM_ID, { commitment: 'confirmed', filters })
  return res.map((a) => toListing(a.pubkey, accountsCoder.decode('Listing', a.account.data)))
}

/** 借り手のレンタル（未精算のもの）。Rental の並び: 識別子 8 バイト + listing 32 バイト + renter … */
export async function fetchRentalsByRenter(connection: Connection, renter: PublicKey): Promise<Rental[]> {
  const res = await connection.getProgramAccounts(PROGRAM_ID, {
    commitment: 'confirmed',
    filters: [
      { memcmp: { offset: 0, bytes: accountsCoder.memcmp('Rental').bytes as string } },
      { memcmp: { offset: 40, bytes: renter.toBase58() } },
    ],
  })
  return res.map((a) => toRental(a.pubkey, accountsCoder.decode('Rental', a.account.data)))
}

export async function fetchListing(connection: Connection, address: PublicKey): Promise<Listing | null> {
  const a = await connection.getAccountInfo(address, 'confirmed')
  if (!a || !a.owner.equals(PROGRAM_ID)) return null
  return toListing(address, accountsCoder.decode('Listing', a.data))
}

export async function fetchRental(connection: Connection, address: PublicKey): Promise<Rental | null> {
  const a = await connection.getAccountInfo(address, 'confirmed')
  if (!a || !a.owner.equals(PROGRAM_ID)) return null
  return toRental(address, accountsCoder.decode('Rental', a.data))
}

/** ブロックチェーン上の現在時刻（unix 秒） */
export async function chainTime(connection: Connection): Promise<number> {
  const slot = await connection.getSlot('confirmed')
  return (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000)
}

// ---------------------------------------------------------------- 命令の作成
function ix(name: string, args: Record<string, unknown>, keys: AccountMeta[]) {
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: ixCoder.encode(name, args) })
}
const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true })
const r = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false })

export function createListingIx(p: {
  owner: PublicKey
  listingId: bigint
  operator: PublicKey
  agentUrl: string
  gpu: string
  tflops: number
  lamportsPerMinute: number
}) {
  const listing = listingPda(p.owner, p.listingId)
  return {
    listing,
    ix: ix(
      'create_listing',
      {
        listing_id: new BN(p.listingId.toString()),
        operator: p.operator,
        agent_url: p.agentUrl,
        gpu: p.gpu.slice(0, 64),
        tflops_x100: Math.round(p.tflops * 100),
        lamports_per_minute: new BN(p.lamportsPerMinute),
      },
      [w(p.owner, true), w(listing), r(SystemProgram.programId)],
    ),
  }
}

export function rentIx(p: {
  renter: PublicKey
  listing: PublicKey
  nonce: bigint
  minutes: number
  lamportsPerMinute: number
  secretHash: Uint8Array
}) {
  const rental = rentalPda(p.listing, p.renter, p.nonce)
  return {
    rental,
    ix: ix(
      'rent_gpu',
      {
        nonce: new BN(p.nonce.toString()),
        minutes: p.minutes,
        expected_lamports_per_minute: new BN(p.lamportsPerMinute),
        secret_hash: Array.from(p.secretHash),
      },
      [w(p.renter, true), w(p.listing), w(rental), r(SystemProgram.programId)],
    ),
  }
}

export const refundIx = (caller: PublicKey, rental: Rental) =>
  ix('refund', {}, [r(caller, true), w(rental.listing), w(rental.address), w(rental.renter)])

export const settleIx = (caller: PublicKey, rental: Rental) =>
  ix('settle', {}, [r(caller, true), w(rental.listing), w(rental.address), w(rental.owner), w(rental.renter)])

export const closeListingIx = (owner: PublicKey, listing: PublicKey) =>
  ix('close_listing', {}, [w(owner, true), w(listing)])

export const updateAgentIx = (authority: PublicKey, listing: PublicKey, agentUrl: string, active: boolean) =>
  ix('update_agent', { agent_url: agentUrl, active }, [r(authority, true), w(listing)])

/** プログラムのエラーを日本語に */
export function programErrorMessage(raw: string): string | null {
  const map: Record<string, string> = {
    ListingBusy: 'この GPU は使用中か、他の人が開始待ちです。',
    ListingInactive: 'この GPU は現在受付を停止しています（エージェントが停止中）。',
    PriceChanged: '価格が変わりました。一覧を更新してからもう一度お試しください。',
    InvalidMinutes: 'レンタル時間は 1〜240 分で指定してください。',
    HasOpenRentals: '未精算のレンタルがあるため取り下げられません。精算・返金が終わってから実行してください。',
    NotEnded: 'まだ終了時刻になっていません。',
    NotPending: 'このレンタルはすでに開始されているため、返金できません。',
    RefundNotAllowed: '開始期限（5 分）を過ぎるまで、借り手以外は返金できません。',
    AcceptDeadlinePassed: '開始期限を過ぎています。返金を受けてください。',
    NotOwner: '出品者のウォレットで操作してください。',
    InvalidUrl: 'エージェントの URL が不正です。',
    InvalidPrice: '価格が範囲外です。',
  }
  for (const [k, v] of Object.entries(map)) if (raw.includes(k)) return v
  return null
}
