import { useMemo, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Code } from '@astryxdesign/core/Code'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { VStack } from '@astryxdesign/core/VStack'
import { PageHeader } from '../components/PageHeader'
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
        [transferIx(wallet.publicKey, recipientKey, lamports), memoIx(wallet.publicKey, 'SolGPU: direct payment')],
        (message) => setStatus({ kind: 'busy', message }),
      )
      setStatus({
        kind: 'success',
        title: '送金が完了しました',
        body: (
          <Text>
            {formatSol(amountNum)} SOL → <Code>{shorten(recipientKey.toBase58())}</Code>
          </Text>
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
    <VStack gap={6} maxWidth={640}>
      <PageHeader
        title="直接送金"
        description="マーケットを通さず、指定したアドレスに SOL を送ります（貸し手への追加支払いなど）。"
      />
      <VStack gap={4}>
        <TextInput
          label="送金先ウォレットアドレス"
          placeholder="Solana のアドレス"
          value={recipient}
          onChange={setRecipient}
          isDisabled={busy}
          autoComplete="off"
          hasSpellCheck={false}
          status={recipient && !recipientKey ? { type: 'error', message: 'アドレスの形式が正しくありません' } : undefined}
        />
        <TextInput
          label="送金数量"
          placeholder="0.01"
          inputMode="decimal"
          value={amount}
          onChange={setAmount}
          isDisabled={busy}
          description="単位は SOL"
        />
      </VStack>
      <VStack gap={2}>
        <Button
          label={busy ? '処理中…' : '送金する'}
          variant="primary"
          size="lg"
          width="100%"
          onClick={send}
          isDisabled={!!validation}
          isLoading={busy}
        />
        {validation && !busy && (
          <Text type="supporting" color="secondary" justify="center" display="block">
            {validation}
          </Text>
        )}
      </VStack>
      <StatusBox status={status} />
    </VStack>
  )
}
