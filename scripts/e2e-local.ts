/**
 * ローカル validator を使った通しテスト（出品 → レンタル → 利用開始 → 精算 / 返金）
 *
 *   1. WSL で: solana-test-validator --bpf-program <PROGRAM_ID> <sorana_market.so> --reset
 *   2. node scripts/e2e-local.ts
 *
 * Phantom の代わりにテスト用の鍵で署名し、本物のエージェント (agent/sorana_agent.py) を起動して確かめる
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js'
import {
  createListingIx,
  fetchListing,
  fetchListings,
  fetchRental,
  fetchRentalsByRenter,
  randomU64,
  refundIx,
  rentIx,
} from '../src/lib/program.ts'

const RPC = 'http://127.0.0.1:8899'
const PORT = 8790
const AGENT = `http://127.0.0.1:${PORT}`
const conn = new Connection(RPC, 'confirmed')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}`)
  if (!cond) failures++
}

async function send(ixs: TransactionInstruction[], signers: Keypair[]) {
  const tx = new Transaction().add(...ixs)
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash()
  tx.recentBlockhash = blockhash
  tx.feePayer = signers[0].publicKey
  tx.sign(...signers)
  const sig = await conn.sendRawTransaction(tx.serialize())
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
  return sig
}

async function api(path: string, body?: unknown) {
  const res = await fetch(AGENT + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: (await res.json()) as Record<string, any> } // eslint-disable-line
}

function startAgent(dataDir: string): Promise<{ proc: ChildProcess; out: string[] }> {
  const proc = spawn(
    join('agent', '.venv', 'Scripts', 'python.exe'),
    ['-W', 'ignore', 'agent/sorana_agent.py', '--rpc', RPC, '--no-tunnel', '--no-browser', '--port', String(PORT), '--data-dir', dataDir],
    { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
  )
  const out: string[] = []
  return new Promise((resolve, reject) => {
    const onData = (d: Buffer) => {
      out.push(...d.toString().split('\n'))
      if (out.some((l) => l.includes('Ctrl + C'))) resolve({ proc, out })
    }
    proc.stdout!.on('data', onData)
    proc.stderr!.on('data', (d: Buffer) => out.push(d.toString()))
    proc.on('exit', (c) => reject(new Error(`agent exited ${c}\n${out.join('\n')}`)))
  })
}

async function airdrop(pk: PublicKey, sol: number) {
  const sig = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL)
  const bh = await conn.getLatestBlockhash()
  await conn.confirmTransaction({ signature: sig, ...bh }, 'confirmed')
}

async function main() {
  const owner = Keypair.generate()
  const renter = Keypair.generate()
  await airdrop(owner.publicKey, 5)
  await airdrop(renter.publicKey, 5)

  // エージェント（テスト用データフォルダ。ベンチマーク結果は固定値を入れておく）
  const dataDir = mkdtempSync(join(tmpdir(), 'sorana-agent-'))
  const PRICE = 25946
  writeFileSync(
    join(dataDir, 'state.json'),
    JSON.stringify({ bench: { gpu: 'Intel(R) Arc(TM) 140T GPU (16GB)', backend: 'xpu', dtype: 'float16', tflops: 12.97, lamportsPerMinute: PRICE } }),
  )
  let { proc, out } = await startAgent(dataDir)
  const code = out.join('\n').match(/code=([0-9a-f]+)/)![1]
  const info = (await api('/info')).data
  console.log('agent operator', info.operator)

  // ---- 出品（Lend ページと同じ: 出品 + エージェントの手数料用に 0.01 SOL）
  console.log('\n[出品]')
  check((await api('/check-code', { code: 'bad' })).status === 403, '古いコードは拒否')
  const listingId = randomU64()
  const { listing, ix: createIx } = createListingIx({
    owner: owner.publicKey,
    listingId,
    operator: new PublicKey(info.operator),
    agentUrl: info.agentUrl,
    gpu: info.gpu,
    tflops: info.tflops,
    lamportsPerMinute: info.lamportsPerMinute,
  })
  await send(
    [createIx, SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: new PublicKey(info.operator), lamports: 0.01 * LAMPORTS_PER_SOL })],
    [owner],
  )
  const act = await api('/activate', { listing: listing.toBase58(), code })
  check(act.status === 200 && act.data.listing === listing.toBase58(), 'エージェントが出品と紐付く')
  check((await api('/activate', { listing: listing.toBase58(), code })).status === 403, '出品リンクは 1 回だけ')
  const all = await fetchListings(conn)
  check(all.some((l) => l.address.equals(listing) && l.active), 'getProgramAccounts で一覧に出る')

  // ---- レンタル → 利用開始 → 精算
  console.log('\n[レンタル → 利用開始 → 精算]')
  const ownerBefore = await conn.getBalance(owner.publicKey)
  const secret = randomBytes(24).toString('hex')
  const hash = createHash('sha256').update(secret).digest()
  const nonce = randomU64()
  const { rental, ix: rIx } = rentIx({ renter: renter.publicKey, listing, nonce, minutes: 1, lamportsPerMinute: PRICE, secretHash: hash })
  await send([rIx], [renter])
  const r0 = await fetchRental(conn, rental)
  check(r0?.status === 'Pending' && r0.amount === PRICE, 'エスクローに代金が預けられた')
  check((await conn.getBalance(rental)) >= PRICE, 'エスクロー口座の残高 ≥ 代金')
  check((await api('/claim', { rental: rental.toBase58(), secret: 'wrong' })).status === 403, '秘密の値が違うと開始できない')
  const c = await api('/claim', { rental: rental.toBase58(), secret })
  check(c.status === 200, `利用開始を依頼 (${c.data.status ?? c.data.error})`)
  let s: Record<string, any> = {} // eslint-disable-line
  for (let i = 0; i < 90; i++) {
    s = (await api('/session', { rental: rental.toBase58(), secret })).data
    if (s.status !== 'starting') break
    await sleep(1000)
  }
  check(s.status === 'ready', `Jupyter 準備完了 (${s.status} ${s.error ?? ''})`)
  const r1 = await fetchRental(conn, rental)
  check(r1?.status === 'Active' && r1.endsAt - r1.startedAt === 60, 'オンチェーンで accept 済み（60 秒）')
  if (s.url) {
    const [base, token] = s.url.split('/lab?token=')
    const j = await fetch(`${base}/api/kernelspecs`, { headers: { Authorization: `token ${token}` } })
    check(j.ok, 'Jupyter API に token でアクセスできる')
  }
  console.log('  …終了と精算を待っています（約 70 秒）')
  for (let i = 0; i < 150; i++) {
    s = (await api('/session', { rental: rental.toBase58(), secret })).data
    if (s.settleSignature) break
    await sleep(1000)
  }
  check(s.status === 'ended', 'セッション終了')
  check(!!s.settleSignature, '精算トランザクション送信')
  check((await fetchRental(conn, rental)) === null, 'エスクロー口座は閉じられた')
  check((await conn.getBalance(owner.publicKey)) - ownerBefore === PRICE, '代金が貸し手に届いた')

  // ---- 返金（開始前に借り手がキャンセル）
  console.log('\n[返金]')
  const renterBefore = await conn.getBalance(renter.publicKey)
  const { rental: rental2, ix: rIx2 } = rentIx({ renter: renter.publicKey, listing, nonce: randomU64(), minutes: 3, lamportsPerMinute: PRICE, secretHash: hash })
  await send([rIx2], [renter])
  const r2 = await fetchRental(conn, rental2)
  const mine = await fetchRentalsByRenter(conn, renter.publicKey)
  check(mine.length === 1 && mine[0].address.equals(rental2), '借り手のウォレットから未精算レンタルを検索できる')
  await send([refundIx(renter.publicKey, r2!)], [renter])
  check((await fetchRental(conn, rental2)) === null, '返金で口座が閉じられた')
  check(renterBefore - (await conn.getBalance(renter.publicKey)) === 10_000, '借り手は手数料 2 回分だけ減った（代金と保証金は戻った）')
  check((await api('/claim', { rental: rental2.toBase58(), secret })).status === 400, '返金済みのレンタルは開始できない')

  // ---- エージェント再起動 → 出品の URL を自動更新
  console.log('\n[エージェント再起動]')
  proc.kill()
  await sleep(1500)
  ;({ proc, out } = await startAgent(dataDir))
  check(out.some((l) => l.includes('受付を再開')), 'オペレーター鍵で update_agent を送信して受付再開')
  const l2 = await fetchListing(conn, listing)
  check(l2?.active === true && l2.agentUrl === AGENT, '出品は受付中のまま')
  check(l2?.openRentals === 0, '未精算レンタルなし')
  if (process.argv.includes('--serve')) {
    console.log('--serve: エージェントを 120 秒動かしたままにします（Web アプリの表示確認用）')
    await sleep(120_000)
  }
  proc.kill()

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  if (failures) console.log(out.slice(-30).join('\n'))
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
