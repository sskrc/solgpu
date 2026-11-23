import type { PublicKey, Transaction } from '@solana/web3.js'

/** Phantom がブラウザに注入するオブジェクト（使う機能だけ型定義） */
export interface PhantomProvider {
  isPhantom?: boolean
  publicKey: PublicKey | null
  isConnected: boolean
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PublicKey }>
  disconnect(): Promise<void>
  signTransaction(tx: Transaction): Promise<Transaction>
  on(event: 'connect' | 'disconnect' | 'accountChanged', handler: (arg: unknown) => void): void
  removeListener?(event: string, handler: (arg: unknown) => void): void
}

declare global {
  interface Window {
    phantom?: { solana?: PhantomProvider }
    solana?: PhantomProvider
  }
}

/** Phantom がインストールされていれば provider を返す */
export function getPhantom(): PhantomProvider | null {
  const p = window.phantom?.solana ?? window.solana
  return p?.isPhantom ? p : null
}
