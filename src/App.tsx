import { useEffect, useState } from 'react'
import { explorer, formatSol, shorten, toFriendlyError } from './lib/solana'
import { useWallet } from './lib/useWallet'
import { Lend } from './pages/Lend'
import { Market } from './pages/Market'
import { MyRentals } from './pages/MyRentals'
import { Transfer } from './pages/Transfer'

type Tab = 'market' | 'rentals' | 'lend' | 'transfer'
const TABS: { id: Tab; label: string }[] = [
  { id: 'market', label: 'GPU を借りる' },
  { id: 'rentals', label: 'マイレンタル' },
  { id: 'lend', label: 'GPU を貸す' },
  { id: 'transfer', label: '直接送金' },
]

/** URL の # 以降を読む（例: #lend?agent=...&code=...） */
function parseHash() {
  const [name, query = ''] = window.location.hash.replace(/^#/, '').split('?')
  const tab = (TABS.some((t) => t.id === name) ? name : 'market') as Tab
  return { tab, params: new URLSearchParams(query) }
}

export default function App() {
  const wallet = useWallet()
  const [route, setRoute] = useState(parseHash)
  const [connectError, setConnectError] = useState('')
  const [rentalsKey, setRentalsKey] = useState(0)

  useEffect(() => {
    const onHash = () => setRoute(parseHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const go = (tab: Tab) => {
    window.location.hash = tab
  }

  const connect = async () => {
    try {
      setConnectError('')
      await wallet.connect()
    } catch (err) {
      setConnectError(toFriendlyError(err).message)
    }
  }

  return (
    <div className="page">
      <header className="header">
        <div className="brand">
          <span className="logo">◎</span>
          <div>
            <h1>Sorana</h1>
            <p className="sub">みんなの GPU を SOL で貸し借り</p>
          </div>
        </div>
        <div className="header-right">
          <span className="badge">● Devnet</span>
          {wallet.publicKey ? (
            <button className="btn ghost" onClick={wallet.disconnect}>
              {shorten(wallet.publicKey.toBase58())} を切断
            </button>
          ) : wallet.phantom ? (
            <button className="btn primary" onClick={connect}>
              Phantom を接続
            </button>
          ) : wallet.detected ? (
            <a className="btn primary" href="https://phantom.com/download" target="_blank" rel="noreferrer">
              Phantom をインストール
            </a>
          ) : null}
        </div>
      </header>
      {connectError && <p className="err-text">{connectError}</p>}

      <div className="notice">
        これは <b>Solana Devnet（テスト用ネットワーク）</b> 専用のデモです。本物のお金は動きません。
      </div>

      {wallet.publicKey && (
        <section className="card wallet">
          <div>
            <div className="label">接続中のウォレット</div>
            <a
              className="mono"
              href={explorer(`address/${wallet.publicKey.toBase58()}`)}
              target="_blank"
              rel="noreferrer"
            >
              {wallet.publicKey.toBase58()}
            </a>
          </div>
          <div className="wallet-right">
            <div className="label">残高 (Devnet)</div>
            <div className="balance">{wallet.balance === null ? '—' : `${formatSol(wallet.balance)} SOL`}</div>
            <div className="wallet-actions">
              <button className="link" onClick={wallet.refreshBalance}>
                更新
              </button>
              <a className="link" href="https://faucet.solana.com/" target="_blank" rel="noreferrer">
                Faucet で SOL を入手 ↗
              </a>
            </div>
          </div>
        </section>
      )}

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${route.tab === t.id ? 'active' : ''}`} onClick={() => go(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      {route.tab === 'market' && (
        <Market
          wallet={wallet}
          onRented={() => {
            setRentalsKey((k) => k + 1)
            go('rentals')
          }}
        />
      )}
      {route.tab === 'rentals' && <MyRentals key={rentalsKey} />}
      {route.tab === 'lend' && (
        <Lend
          key={route.params.get('agent') ?? ''}
          wallet={wallet}
          agent={route.params.get('agent') ?? ''}
          code={route.params.get('code') ?? ''}
        />
      )}
      {route.tab === 'transfer' && <Transfer wallet={wallet} />}

      <footer className="muted small center">Sorana — Solana Hackathon Demo (Devnet only)</footer>
    </div>
  )
}
