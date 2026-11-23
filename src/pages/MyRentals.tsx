import { useCallback, useEffect, useState } from 'react'
import { agentApi, loadRentals, type Rental, type SessionInfo } from '../lib/market'
import { explorer, lamportsToSol, shorten } from '../lib/solana'

type Live = { session?: SessionInfo; fetchedAt?: number; error?: string; loading?: boolean }

/** 借りた GPU の一覧。Jupyter を開く・残り時間を見る・利用開始の再試行ができる */
export function MyRentals() {
  const [rentals] = useState<Rental[]>(() => loadRentals())
  const [live, setLive] = useState<Record<string, Live>>({})
  const [now, setNow] = useState(() => Date.now())

  const poll = useCallback(async (r: Rental, useClaim = false) => {
    if (!r.signature) return
    const key = r.signature
    setLive((s) => ({ ...s, [key]: { ...s[key], loading: true } }))
    try {
      const session = useClaim
        ? await agentApi.claim(r.agentUrl, r.signature, r.secret)
        : await agentApi.session(r.agentUrl, r.signature, r.secret).catch(() =>
            // エージェントがまだセッションを知らない（開始前・失敗後）なら claim で開始を試みる
            agentApi.claim(r.agentUrl, r.signature!, r.secret),
          )
      setLive((s) => ({ ...s, [key]: { session, fetchedAt: Date.now() } }))
    } catch (err) {
      setLive((s) => ({ ...s, [key]: { error: (err as Error).message } }))
    }
  }, [])

  // 進行中のレンタルを定期的に確認
  useEffect(() => {
    const active = rentals.filter((r) => r.signature && Date.now() - r.createdAt < 6 * 60 * 60 * 1000)
    const tick = () => active.forEach((r) => poll(r))
    const first = setTimeout(tick, 0)
    const t = setInterval(tick, 5000)
    return () => {
      clearTimeout(first)
      clearInterval(t)
    }
  }, [rentals, poll])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  if (rentals.length === 0) {
    return (
      <section className="card">
        <h2>マイレンタル</h2>
        <p className="muted">まだレンタルはありません。「GPU を借りる」タブから借りられます。</p>
      </section>
    )
  }

  return (
    <section className="card">
      <h2>マイレンタル</h2>
      <p className="muted small">
        この記録（利用に必要な秘密の値を含む）はこのブラウザにだけ保存されています。別のブラウザからは使えません。
      </p>
      <div className="rentals">
        {rentals.map((r) => {
          const l = r.signature ? live[r.signature] : undefined
          const s = l?.session
          // サーバー時計とのずれを補正して残り時間を出す
          const serverNow = s ? s.now + (now - (l?.fetchedAt ?? now)) / 1000 : 0
          const remaining = s?.expiresAt ? Math.max(0, Math.floor(s.expiresAt - serverNow)) : 0
          return (
            <div className="rental" key={r.reservationId}>
              <div className="row-between">
                <div>
                  <b>{r.gpu}</b> × {r.minutes} 分 ・ {lamportsToSol(r.lamports)} SOL
                  <div className="muted small">{new Date(r.createdAt).toLocaleString('ja-JP')}</div>
                </div>
                <div>
                  {!r.signature && <span className="tag warn">未払い</span>}
                  {s?.status === 'starting' && <span className="tag">準備中</span>}
                  {s?.status === 'ready' && remaining > 0 && <span className="tag ok">利用中</span>}
                  {(s?.status === 'ended' || (s?.status === 'ready' && remaining === 0)) && <span className="tag">終了</span>}
                  {s?.status === 'error' && <span className="tag warn">エラー</span>}
                </div>
              </div>

              {s?.status === 'starting' && (
                <p>
                  <span className="spinner" /> GPU 環境（Jupyter）を起動しています… 通常 10〜30 秒ほどかかります
                </p>
              )}
              {s?.status === 'ready' && remaining > 0 && (
                <>
                  <a className="btn primary" href={s.url} target="_blank" rel="noreferrer">
                    Jupyter を開く（GPU を使う）↗
                  </a>
                  <p className="countdown">
                    残り {Math.floor(remaining / 60)} 分 {String(remaining % 60).padStart(2, '0')} 秒
                  </p>
                  <p className="muted small">
                    時間になると環境は自動で停止し、ファイルは消えます。必要なものはダウンロードしておいてください。
                    <br />
                    開けない（「サイトにアクセスできません」）場合は、URL の準備中です。10〜30 秒待ってから再読み込みしてください。
                  </p>
                </>
              )}
              {s?.status === 'error' && <p className="err-text">貸し手側でエラー: {s.error}</p>}
              {l?.error && (
                <p className="err-text">
                  {/failed to fetch|タイムアウト/i.test(l.error)
                    ? '貸し手のエージェントに接続できません（停止している可能性があります）。'
                    : l.error}
                </p>
              )}
              {r.signature && (
                <div className="row-actions">
                  {(l?.error || s?.status === 'error') && (
                    <button className="btn ghost small-btn" onClick={() => poll(r, true)} disabled={l?.loading}>
                      利用開始を再試行
                    </button>
                  )}
                  <a className="small" href={explorer(`tx/${r.signature}`)} target="_blank" rel="noreferrer">
                    支払い {shorten(r.signature)} ↗
                  </a>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
