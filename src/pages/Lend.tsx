import { useEffect, useState } from 'react'
import { StatusBox, type Status } from '../components/StatusBox'
import { agentApi, listMemo, sha256Hex, type AgentInfo } from '../lib/market'
import {
  LAMPORTS_PER_TFLOPS_MINUTE,
  lamportsToSol,
  memoIx,
  MIN_LAMPORTS_PER_MINUTE,
  REGISTRY,
  signAndSend,
  toFriendlyError,
  transferIx,
} from '../lib/solana'
import type { Wallet } from '../lib/useWallet'

/** GPU を貸す（エージェントの出品） */
export function Lend({ wallet, agent, code }: { wallet: Wallet; agent: string; code: string }) {
  const [info, setInfo] = useState<AgentInfo | null>(null)
  const [infoError, setInfoError] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  useEffect(() => {
    if (!agent) return
    let alive = true
    agentApi
      .info(agent)
      .then((i) => alive && setInfo(i))
      .catch((e) => alive && setInfoError(toFriendlyError(e).message))
    return () => {
      alive = false
    }
  }, [agent])

  const busy = status.kind === 'busy'

  const list = async () => {
    if (!wallet.phantom || !wallet.publicKey || !info) return
    try {
      // 目印アドレス (REGISTRY) に 0 SOL 送るトランザクションにメモを付ける → 誰でも出品一覧として読める
      const codeHash = await sha256Hex(code)
      const signature = await signAndSend(
        wallet.phantom,
        wallet.publicKey,
        [transferIx(wallet.publicKey, REGISTRY, 0), memoIx(wallet.publicKey, listMemo(agent, codeHash))],
        (message) => setStatus({ kind: 'busy', message }),
      )
      setStatus({ kind: 'busy', message: 'エージェントに出品を知らせています…' })
      const updated = await agentApi.activate(agent, signature, code)
      setInfo(updated)
      wallet.refreshBalance()
      setStatus({
        kind: 'success',
        title: '出品しました！',
        body: <p>「GPU を借りる」タブに表示されます。エージェントを動かしている間だけ貸し出されます。</p>,
        signature,
      })
    } catch (err) {
      setStatus({ kind: 'error', ...toFriendlyError(err) })
    }
  }

  return (
    <>
      {!agent && (
        <section className="card">
          <h2>あなたの GPU を貸し出す</h2>
          <ol className="steps">
            <li>
              貸し出したい PC で <b>Sorana エージェント</b> を起動します（手順は README の「GPU を貸す」）。
              <pre>{`cd agent\n.\\.venv\\Scripts\\python sorana_agent.py --i-understand-the-risk`}</pre>
            </li>
            <li>エージェントが GPU のベンチマークを行い、1 分あたりの価格を自動で決めます。</li>
            <li>
              画面に表示された <b>出品リンク</b> をこのブラウザで開き、Phantom で「出品する」を承認します。
            </li>
            <li>借りた人の支払いは、あなたのウォレットに直接届きます。</li>
          </ol>
          <p className="muted small">
            価格ルール: 計測した性能 (TFLOPS) × {lamportsToSol(LAMPORTS_PER_TFLOPS_MINUTE)} SOL / 分（最低{' '}
            {lamportsToSol(MIN_LAMPORTS_PER_MINUTE)} SOL / 分）
          </p>
          <div className="warn-box">
            ⚠️ 借りた人は Jupyter からあなたの PC 上でプログラムを実行できます（専用フォルダで起動しますが、完全な隔離ではありません）。
            大事なデータの無い PC で、デモの間だけ起動してください。
          </div>
        </section>
      )}

      {agent && (
        <section className="card">
          <h2>GPU を出品する</h2>
          {infoError && (
            <p className="err-text">
              エージェントに接続できません: {infoError}
              <br />
              エージェントが起動しているか確認し、表示された最新のリンクを開いてください。
            </p>
          )}
          {!info && !infoError && (
            <p className="muted">
              <span className="spinner" /> エージェントに接続しています…
            </p>
          )}
          {info && (
            <>
              <div className="bench">
                <div>
                  <div className="label">GPU</div>
                  <div className="gpu-name">{info.gpu}</div>
                  <div className="muted small">{info.backend.toUpperCase()}</div>
                </div>
                <div>
                  <div className="label">ベンチマーク ({info.dtype} 行列積)</div>
                  <div className="balance">{info.tflops} TFLOPS</div>
                </div>
                <div>
                  <div className="label">自動で決まった価格</div>
                  <div className="balance">{lamportsToSol(info.lamportsPerMinute)} SOL / 分</div>
                  <div className="muted small">1 時間 = {lamportsToSol(info.lamportsPerMinute * 60)} SOL</div>
                </div>
              </div>
              <p className="muted small mono break">エージェント: {agent}</p>
              {info.payout && (
                <p className="small">
                  現在の受取ウォレット: <span className="mono">{info.payout}</span>
                </p>
              )}
              {!wallet.publicKey ? (
                <p className="muted center">右上から Phantom を接続してください（このウォレットが受取先になります）。</p>
              ) : (
                <button className="btn primary big" onClick={list} disabled={busy || !code}>
                  {busy ? '処理中…' : 'このウォレットで出品する'}
                </button>
              )}
              {!code && <p className="err-text small">リンクに認証コードがありません。エージェントに表示されたリンクを開いてください。</p>}
              <p className="muted small center">出品には少額の手数料（約 0.000005 SOL）がかかります。</p>
            </>
          )}
          <StatusBox status={status} />
        </section>
      )}
    </>
  )
}
