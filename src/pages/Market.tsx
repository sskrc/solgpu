import { useCallback, useEffect, useState } from 'react'
import { StatusBox, type Status } from '../components/StatusBox'
import { agentApi, loadListings, randomSecret, rentMemo, saveRental, sha256Hex, type Listing } from '../lib/market'
import {
  FEE_BUFFER_LAMPORTS,
  LAMPORTS_PER_SOL,
  lamportsToSol,
  memoIx,
  PublicKey,
  SentButUnconfirmedError,
  shorten,
  signAndSend,
  toFriendlyError,
  transferIx,
} from '../lib/solana'
import type { Wallet } from '../lib/useWallet'

/** GPU を借りる（マーケット一覧） */
export function Market({ wallet, onRented }: { wallet: Wallet; onRented: () => void }) {
  const [listings, setListings] = useState<Listing[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [minutes, setMinutes] = useState('10')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  const reload = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      setListings(await loadListings())
    } catch (err) {
      setLoadError(toFriendlyError(err).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(reload, 0)
    return () => clearTimeout(t)
  }, [reload])

  const busy = status.kind === 'busy'
  const listing = listings?.find((l) => l.agentUrl === selected) ?? null
  const mins = Math.floor(Number(minutes))
  const total = listing?.info ? mins * listing.info.lamportsPerMinute : 0

  const validation = (() => {
    if (!wallet.publicKey) return 'まずウォレットを接続してください。'
    if (!listing?.info) return 'GPU を選んでください。'
    if (listing.info.payout === wallet.publicKey.toBase58()) return '自分が出品した GPU は借りられません。'
    if (!Number.isInteger(mins) || mins < 1 || mins > listing.info.maxMinutes)
      return `レンタル時間は 1〜${listing.info.maxMinutes} 分で指定してください。`
    if (wallet.balance !== null && total + FEE_BUFFER_LAMPORTS > wallet.balance * LAMPORTS_PER_SOL)
      return '残高が足りません（手数料分も必要です）。'
    return null
  })()

  const rent = async () => {
    if (!wallet.phantom || !wallet.publicKey || !listing?.info || validation) return
    const base = listing.agentUrl
    try {
      // 1. GPU を予約（同時に 2 人が支払ってしまうのを防ぐ）
      setStatus({ kind: 'busy', message: 'GPU を予約しています…' })
      const res = await agentApi.reserve(base, wallet.publicKey.toBase58())
      if (res.payout !== listing.lister || res.lamportsPerMinute !== listing.info.lamportsPerMinute) {
        throw new Error('貸し手の情報が出品内容と一致しません。一覧を更新してください。')
      }
      const lamports = mins * res.lamportsPerMinute

      // 2. 「支払った本人」だけが使えるように、秘密の値を作ってハッシュをメモに入れる
      const secret = randomSecret()
      const hash = await sha256Hex(secret)
      const rental = {
        agentUrl: base,
        gpu: listing.info.gpu,
        minutes: mins,
        lamports,
        secret,
        reservationId: res.reservationId,
        createdAt: Date.now(),
      }
      saveRental(rental) // 支払い前に保存（途中でページを閉じても後から利用開始できる）

      // 3. 貸し手のウォレットに直接送金
      let signature: string
      try {
        signature = await signAndSend(
          wallet.phantom,
          wallet.publicKey,
          [
            transferIx(wallet.publicKey, new PublicKey(res.payout), lamports),
            memoIx(wallet.publicKey, rentMemo(res.reservationId, mins, hash)),
          ],
          (message) => setStatus({ kind: 'busy', message }),
        )
      } catch (err) {
        // 送信はできたが確認に失敗した場合も、署名を保存して「マイレンタル」から再試行できるようにする
        if (err instanceof SentButUnconfirmedError) {
          saveRental({ ...rental, signature: err.signature })
          throw new Error(
            '送信済みですが完了を確認できませんでした。「マイレンタル」タブで状態を確認し、必要なら「利用開始を再試行」を押してください。',
          )
        }
        throw err
      }
      saveRental({ ...rental, signature })
      wallet.refreshBalance()

      // 4. 貸し手のエージェントに支払いを確認してもらい、Jupyter を起動してもらう
      setStatus({ kind: 'busy', message: '貸し手が支払いを確認し、GPU 環境を準備しています…' })
      try {
        await agentApi.claim(base, signature, secret)
      } catch (err) {
        setStatus({
          kind: 'error',
          message: `支払いは完了しましたが、利用開始に失敗しました: ${(err as Error).message}`,
          detail: '「マイレンタル」タブから再試行できます。',
          signature,
        })
        return
      }
      setStatus({ kind: 'idle' })
      onRented()
    } catch (err) {
      setStatus({ kind: 'error', ...toFriendlyError(err) })
    }
  }

  return (
    <>
      <section className="card">
        <div className="row-between">
          <h2>1. GPU を選ぶ</h2>
          <button className="btn ghost small-btn" onClick={reload} disabled={loading}>
            {loading ? '読み込み中…' : '↻ 更新'}
          </button>
        </div>
        <p className="muted small">
          いま貸し出し中（オンライン）の GPU です。価格はベンチマーク結果から自動で決まります。
        </p>
        {loadError && <p className="err-text">{loadError}</p>}
        {listings === null && !loadError && (
          <p className="muted">
            <span className="spinner" /> Devnet から出品を読み込んでいます…
          </p>
        )}
        {listings?.length === 0 && (
          <p className="muted">
            オンラインの GPU はまだありません。「GPU を貸す」タブの手順で、あなたの GPU を出品できます。
          </p>
        )}
        <div className="gpu-grid">
          {listings?.map((l) => {
            const i = l.info!
            const mine = wallet.publicKey?.toBase58() === l.lister
            return (
              <button
                key={l.agentUrl}
                className={`gpu ${selected === l.agentUrl ? 'selected' : ''}`}
                onClick={() => setSelected(l.agentUrl)}
                disabled={busy}
              >
                <div className="gpu-name">{i.gpu}</div>
                <div className="muted small">
                  {i.backend.toUpperCase()} ・ {i.tflops} TFLOPS ({i.dtype})
                </div>
                <div className="gpu-price">{lamportsToSol(i.lamportsPerMinute)} SOL / 分</div>
                <div className="small">
                  {i.busy ? <span className="tag warn">使用中</span> : <span className="tag ok">空き</span>}
                  {mine && <span className="tag">自分の出品</span>}
                  <span className="muted"> 貸し手 {shorten(l.lister)}</span>
                </div>
              </button>
            )
          })}
        </div>
      </section>

      <section className="card">
        <h2>2. 時間を決めてレンタル</h2>
        <div className="form">
          <label>
            <span>レンタル時間（分）</span>
            <input
              type="number"
              min="1"
              step="1"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              disabled={busy}
            />
          </label>
          {listing?.info && (
            <div className="summary">
              <div>
                {listing.info.gpu} × {Number.isInteger(mins) && mins > 0 ? mins : '—'} 分
              </div>
              <div className="total">{lamportsToSol(total)} SOL</div>
              <div className="muted small">送金先（貸し手）: <span className="mono">{listing.lister}</span></div>
            </div>
          )}
        </div>
        <button className="btn primary big" onClick={rent} disabled={busy || !!validation || listing?.info?.busy}>
          {busy ? '処理中…' : listing?.info?.busy ? 'この GPU は使用中です' : 'レンタルする（SOL を支払う）'}
        </button>
        {validation && !busy && <p className="muted small center">{validation}</p>}
        <p className="muted small center">
          支払いは貸し手のウォレットに直接送られます。デモのため返金機能はありません。利用時間は GPU
          環境が使えるようになった時点から数えます。
        </p>
        <StatusBox status={status} />
      </section>
    </>
  )
}
