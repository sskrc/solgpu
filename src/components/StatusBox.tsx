import type { ReactNode } from 'react'
import { explorer, type FriendlyError } from '../lib/solana'

export type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; message: string }
  | { kind: 'success'; title: string; body?: ReactNode; signature?: string }
  | ({ kind: 'error' } & FriendlyError)

/** 処理中・成功・エラーの表示 */
export function StatusBox({ status }: { status: Status }) {
  if (status.kind === 'idle') return null
  return (
    <div className={`status ${status.kind}`} aria-live="polite">
      {status.kind === 'busy' && (
        <p>
          <span className="spinner" /> {status.message}
        </p>
      )}
      {status.kind === 'success' && (
        <>
          <p className="big-text">✅ {status.title}</p>
          {status.body}
          {status.signature && (
            <>
              <p>
                <a href={explorer(`tx/${status.signature}`)} target="_blank" rel="noreferrer">
                  Solana Explorer で確認する ↗
                </a>
              </p>
              <p className="mono small break muted">署名: {status.signature}</p>
            </>
          )}
        </>
      )}
      {status.kind === 'error' && (
        <>
          <p className="big-text">⚠️ {status.message}</p>
          {status.signature && (
            <p>
              <a href={explorer(`tx/${status.signature}`)} target="_blank" rel="noreferrer">
                Solana Explorer で結果を確認する ↗
              </a>
            </p>
          )}
          {status.detail && status.detail !== status.message && (
            <details>
              <summary>詳しいエラー内容</summary>
              <pre>{status.detail}</pre>
            </details>
          )}
        </>
      )}
    </div>
  )
}
