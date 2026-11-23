import { useCallback, useEffect, useState } from 'react'
import type { PublicKey } from '@solana/web3.js'
import { getPhantom, type PhantomProvider } from '../phantom'
import { connection, LAMPORTS_PER_SOL } from './solana'

export type Wallet = ReturnType<typeof useWallet>

/** Phantom の接続状態と残高を管理する */
export function useWallet() {
  const [phantom, setPhantom] = useState<PhantomProvider | null>(null)
  const [detected, setDetected] = useState(false)
  const [publicKey, setPublicKey] = useState<PublicKey | null>(null)
  const [balance, setBalance] = useState<number | null>(null)

  useEffect(() => {
    // 拡張機能の注入が少し遅れることがあるので、読み込み後に確認する
    const timer = setTimeout(() => {
      const p = getPhantom()
      setPhantom(p)
      setDetected(true)
      if (!p) return
      p.on('connect', (pk) => setPublicKey(pk as PublicKey))
      p.on('disconnect', () => setPublicKey(null))
      p.on('accountChanged', (pk) => (pk ? setPublicKey(pk as PublicKey) : p.connect().catch(() => setPublicKey(null))))
      // 以前に許可したことがあれば、ポップアップ無しで再接続する
      p.connect({ onlyIfTrusted: true })
        .then(({ publicKey }) => setPublicKey(publicKey))
        .catch(() => {})
    }, 300)
    return () => clearTimeout(timer)
  }, [])

  const refreshBalance = useCallback(async () => {
    if (!publicKey) return
    try {
      setBalance((await connection.getBalance(publicKey)) / LAMPORTS_PER_SOL)
    } catch {
      /* RPC 混雑時は前の値のまま */
    }
  }, [publicKey])

  useEffect(() => {
    if (!publicKey) return
    let alive = true
    connection
      .getBalance(publicKey)
      .then((b) => alive && setBalance(b / LAMPORTS_PER_SOL))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [publicKey])

  const connect = async () => {
    if (!phantom) return
    const { publicKey } = await phantom.connect()
    setPublicKey(publicKey)
  }

  const disconnect = async () => {
    await phantom?.disconnect()
    setPublicKey(null)
    setBalance(null)
  }

  return { phantom, detected, publicKey, balance: publicKey ? balance : null, refreshBalance, connect, disconnect }
}
