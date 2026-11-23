import { useMemo, useState } from 'react'
import { StatusBox, type Status } from '../components/StatusBox'
import {
  checkRentForRecipient,
  FEE_BUFFER_LAMPORTS,
  formatSol,
  LAMPORTS_PER_SOL,
  memoIx,
  PublicKey,
  shorten,
  signAndSend,
  toFriendlyError,
  transferIx,
} from '../lib/solana'
import type { Wallet } from '../lib/useWallet'

/** 送金先と数量を自由に指定して SOL を送る（マーケットを使わない直接送金） */
export function Transfer({ wallet }: { wallet: Wallet }) {
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const busy = status.kind === 'busy'

  const recipientKey = useMemo(() => {
    try {
      return recipient.trim() ? new PublicKey(recipient.trim()) : null
    } catch {
      return null
    }
  }, [recipient])
  const amountNum = Number(amount)
  const lamports = Math.round(amountNum * LAMPORTS_PER_SOL)

  const validation = (() => {
    if (!wallet.publicKey) return 'まずウォレットを接続してください。'
    if (!recipient.trim()) return '送金先アドレスを入力してください。'
    if (!recipientKey) return '送金先アドレスの形式が正しくありません。'
    if (recipientKey.equals(wallet.publicKey)) return '自分自身には送金できません。'
    if (!amount || !Number.isFinite(amountNum) || amountNum <= 0) return '0 より大きい金額を入力してください。'
    if (lamports < 1) return '金額が小さすぎます（最小 0.000000001 SOL）。'
    if (wallet.balance !== null && lamports + FEE_BUFFER_LAMPORTS > wallet.balance * LAMPORTS_PER_SOL)
      return '残高が足りません（手数料分も必要です）。'
    return null
  })()

  const send = async () => {
    if (!wallet.phantom || !wallet.publicKey || !recipientKey || validation) return
    try {
      setStatus({ kind: 'busy', message: '送金内容を確認しています…' })
      const rentError = await checkRentForRecipient(recipientKey, lamports)
      if (rentError) return setStatus({ kind: 'error', message: rentError })
      const signature = await signAndSend(
        wallet.phantom,
        wallet.publicKey,
        [transferIx(wallet.publicKey, recipientKey, lamports), memoIx(wallet.publicKey, 'Sorana: direct payment')],
        (message) => setStatus({ kind: 'busy', message }),
      )
      setStatus({
        kind: 'success',
        title: '送金が完了しました！',
        body: (
          <p>
            {formatSol(amountNum)} SOL → <span className="mono">{shorten(recipientKey.toBase58())}</span>
          </p>
        ),
        signature,
      })
      wallet.refreshBalance()
    } catch (err) {
      setStatus({ kind: 'error', ...toFriendlyError(err) })
      wallet.refreshBalance()
    }
  }

  return (
    <section className="card">
      <h2>直接送金</h2>
      <p className="muted small">マーケットを通さず、指定したアドレスに SOL を送ります（貸し手への追加支払いなど）。</p>
      <div className="form">
        <label>
          <span>送金先ウォレットアドレス</span>
          <input
            className="mono"
            placeholder="Solana のアドレス"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            disabled={busy}
          />
          {recipient && !recipientKey && <small className="err-text">アドレスの形式が正しくありません</small>}
        </label>
        <label>
          <span>送金数量（SOL）</span>
          <input
            type="number"
            min="0"
            step="0.001"
            placeholder="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={busy}
          />
        </label>
      </div>
      <button className="btn primary big" onClick={send} disabled={busy || !!validation}>
        {busy ? '処理中…' : '送金する'}
      </button>
      {validation && !busy && <p className="muted small center">{validation}</p>}
      <StatusBox status={status} />
    </section>
  )
}
