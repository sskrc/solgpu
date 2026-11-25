import type { ReactNode } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Code } from '@astryxdesign/core/Code'
import { Collapsible } from '@astryxdesign/core/Collapsible'
import { HStack } from '@astryxdesign/core/HStack'
import { Link } from '@astryxdesign/core/Link'
import { Spinner } from '@astryxdesign/core/Spinner'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { explorer, shorten, type FriendlyError } from '../lib/solana'

export type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; message: string }
  | { kind: 'success'; title: string; body?: ReactNode; signature?: string }
  | ({ kind: 'error' } & FriendlyError)

function TxLink({ signature, label }: { signature: string; label: string }) {
  return (
    <HStack gap={2} align="center" wrap="wrap">
      <Link href={explorer(`tx/${signature}`)} isExternalLink>
        {label}
      </Link>
      <Text type="supporting" color="secondary">
        署名 <Code color="secondary">{shorten(signature)}</Code>
      </Text>
    </HStack>
  )
}

/** 処理中・成功・エラーの表示 */
export function StatusBox({ status }: { status: Status }) {
  if (status.kind === 'idle') return null

  if (status.kind === 'busy') {
    return (
      <HStack gap={2} align="center" aria-live="polite">
        <Spinner size="sm" aria-label="処理中" />
        <Text color="secondary">{status.message}</Text>
      </HStack>
    )
  }

  if (status.kind === 'success') {
    const hasBody = status.body || status.signature
    return (
      <Banner status="success" title={status.title} collapsible={false}>
        {hasBody && (
          <VStack gap={2}>
            {status.body}
            {status.signature && <TxLink signature={status.signature} label="Solana Explorer で確認" />}
          </VStack>
        )}
      </Banner>
    )
  }

  const hasDetail = status.detail && status.detail !== status.message
  return (
    <Banner status="error" title={status.message} collapsible={false}>
      {(status.signature || hasDetail) && (
        <VStack gap={2}>
          {status.signature && <TxLink signature={status.signature} label="Solana Explorer で結果を確認" />}
          {hasDetail && (
            <Collapsible trigger={<Text type="supporting">詳しいエラー内容</Text>} defaultIsOpen={false}>
              <Text type="code" color="secondary" wordBreak="break-all">
                {status.detail}
              </Text>
            </Collapsible>
          )}
        </VStack>
      )}
    </Banner>
  )
}
