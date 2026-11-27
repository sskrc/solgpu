import { useMemo, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Code } from '@astryxdesign/core/Code'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { VStack } from '@astryxdesign/core/VStack'
import { PageHeader } from '../components/PageHeader'
import { t } from '../lib/i18n'
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
    if (!wallet.publicKey) return t('まずウォレットを接続してください。', 'Connect your wallet first.')
    if (!recipient.trim()) return t('送金先アドレスを入力してください。', 'Enter a recipient address.')
    if (!recipientKey) return t('送金先アドレスの形式が正しくありません。', 'The recipient address is not valid.')
    if (recipientKey.equals(wallet.publicKey)) return t('自分自身には送金できません。', 'You cannot send to yourself.')
    if (!amount || !Number.isFinite(amountNum) || amountNum <= 0) return t('0 より大きい金額を入力してください。', 'Enter an amount greater than 0.')
    if (lamports < 1) return t('金額が小さすぎます（最小 0.000000001 SOL）。', 'The amount is too small (minimum 0.000000001 SOL).')
    if (wallet.balance !== null && lamports + FEE_BUFFER_LAMPORTS > wallet.balance * LAMPORTS_PER_SOL)
      return t('残高が足りません（手数料分も必要です）。', 'Insufficient balance (the fee is needed too).')
    return null
  })()

  const send = async () => {
    if (!wallet.phantom || !wallet.publicKey || !recipientKey || validation) return
    try {
      setStatus({ kind: 'busy', message: t('送金内容を確認しています…', 'Checking the transfer…') })
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
        title: t('送金が完了しました', 'Transfer complete'),
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
        title={t('直接送金', 'Send SOL')}
        description={t(
          'マーケットを通さず、指定したアドレスに SOL を送ります（貸し手への追加支払いなど）。',
          'Send SOL straight to any address without the marketplace (for example, an extra payment to a lender).',
        )}
      />
      <VStack gap={4}>
        <TextInput
          label={t('送金先ウォレットアドレス', 'Recipient wallet address')}
          placeholder={t('Solana のアドレス', 'Solana address')}
          value={recipient}
          onChange={setRecipient}
          isDisabled={busy}
          autoComplete="off"
          hasSpellCheck={false}
          status={recipient && !recipientKey ? { type: 'error', message: t('アドレスの形式が正しくありません', 'Invalid address format') } : undefined}
        />
        <TextInput
          label={t('送金数量', 'Amount')}
          placeholder="0.01"
          inputMode="decimal"
          value={amount}
          onChange={setAmount}
          isDisabled={busy}
          description={t('単位は SOL', 'In SOL')}
        />
      </VStack>
      <VStack gap={2}>
        <Button
          label={busy ? t('処理中…', 'Processing…') : t('送金する', 'Send')}
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
