import { useCallback, useEffect, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Card } from '@astryxdesign/core/Card'
import { Code } from '@astryxdesign/core/Code'
import { Collapsible } from '@astryxdesign/core/Collapsible'
import { Divider } from '@astryxdesign/core/Divider'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Grid } from '@astryxdesign/core/Grid'
import { Heading } from '@astryxdesign/core/Heading'
import { HStack } from '@astryxdesign/core/HStack'
import { List, ListItem } from '@astryxdesign/core/List'
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList'
import { TextInput } from '@astryxdesign/core/TextInput'
import { SelectableCard } from '@astryxdesign/core/SelectableCard'
import { Spinner } from '@astryxdesign/core/Spinner'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { Text } from '@astryxdesign/core/Text'
import { Banner } from '@astryxdesign/core/Banner'
import { VStack } from '@astryxdesign/core/VStack'
import { SectionTitle } from '../components/PageHeader'
import { StatusBox, type Status } from '../components/StatusBox'
import { t } from '../lib/i18n'
import { agentApi, loadMarket, randomSecret, saveRental, sha256, type MarketItem } from '../lib/market'
import { randomU64, rentIx } from '../lib/program'
import {
  FEE_BUFFER_LAMPORTS,
  LAMPORTS_PER_SOL,
  lamportsToSol,
  perMin,
  priceDiffLabel,
  REFERENCE_TOLERANCE_LAMPORTS,
  referencePrice,
  SentButUnconfirmedError,
  shorten,
  signAndSend,
  toFriendlyError,
} from '../lib/solana'
import type { Wallet } from '../lib/useWallet'

/** GPU を借りる（マーケット一覧） */
export function Market({ wallet, onRented }: { wallet: Wallet; onRented: () => void }) {
  const [items, setItems] = useState<MarketItem[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [minutes, setMinutes] = useState('10')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  const reload = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      setItems(await loadMarket())
    } catch (err) {
      setLoadError(toFriendlyError(err).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(reload, 0)
    return () => clearTimeout(t)
  }, [reload])

  const busy = status.kind === 'busy'
  const item = items?.find((x) => x.listing.address.toBase58() === selected) ?? null
  const isBusy = (x: MarketItem) => x.info.busy || x.listing.busyUntil > Date.now() / 1000
  const mins = Math.floor(Number(minutes))
  const total = item ? mins * item.listing.lamportsPerMinute : 0

  const validation = (() => {
    if (!wallet.publicKey) return t('まずウォレットを接続してください。', 'Connect your wallet first.')
    if (!item) return t('GPU を選んでください。', 'Choose a GPU.')
    if (item.listing.owner.equals(wallet.publicKey)) return t('自分が出品した GPU は借りられません。', 'You cannot rent your own GPU.')
    if (isBusy(item)) return t('この GPU は使用中です。', 'This GPU is in use.')
    if (!Number.isInteger(mins) || mins < 1 || mins > item.info.maxMinutes)
      return t(
        `レンタル時間は 1〜${item.info.maxMinutes} 分で指定してください。`,
        `Rental time must be 1–${item.info.maxMinutes} minutes.`,
      )
    if (wallet.balance !== null && total + 3_000_000 + FEE_BUFFER_LAMPORTS > wallet.balance * LAMPORTS_PER_SOL)
      return t(
        '残高が足りません（代金 + 一時的な保証金 約 0.003 SOL + 手数料が必要です）。',
        'Insufficient balance (you need the price + a temporary deposit of about 0.003 SOL + fees).',
      )
    return null
  })()

  const rent = async () => {
    if (!wallet.phantom || !wallet.publicKey || !item || validation) return
    const { listing, info } = item
    // 「支払った本人」だけが GPU 環境を受け取れるよう、秘密の値を作ってハッシュをプログラムに預ける
    const secret = randomSecret()
    const { rental, ix } = rentIx({
      renter: wallet.publicKey,
      listing: listing.address,
      nonce: randomU64(),
      minutes: mins,
      lamportsPerMinute: listing.lamportsPerMinute,
      secretHash: await sha256(secret),
    })
    const saved = {
      rental: rental.toBase58(),
      listing: listing.address.toBase58(),
      agentUrl: listing.agentUrl,
      gpu: listing.gpu,
      minutes: mins,
      lamports: total,
      secret,
      createdAt: Date.now(),
    }
    saveRental(saved) // 支払い前に保存（途中でページを閉じても「マイレンタル」から続きができる）
    try {
      // 1. 代金をエスクロー（SolGPU プログラムの口座）に預ける
      try {
        await signAndSend(wallet.phantom, wallet.publicKey, [ix], (message) => setStatus({ kind: 'busy', message }))
      } catch (err) {
        if (err instanceof SentButUnconfirmedError) {
          throw new Error(
            t(
              '送信済みですが完了を確認できませんでした。「マイレンタル」タブで状態を確認してください。',
              'Sent, but completion could not be confirmed. Check its status on the “My rentals” tab.',
            ),
          )
        }
        throw err
      }
      saveRental({ ...saved, paid: true })
      wallet.refreshBalance()

      // 2. 貸し手のエージェントに開始を依頼（エージェントが準備できたらオンチェーンで「開始」が記録される）
      setStatus({ kind: 'busy', message: t('貸し手のエージェントが GPU 環境を準備しています…', "The lender's agent is preparing the GPU environment…") })
      try {
        await agentApi.claim(info.agentUrl, rental.toBase58(), secret)
      } catch (err) {
        setStatus({
          kind: 'error',
          message: `${t(
            '代金はエスクローに預けられましたが、開始の依頼に失敗しました',
            'Payment is in escrow, but the start request failed',
          )}: ${(err as Error).message}`,
          detail: t(
            '「マイレンタル」から再試行するか、キャンセルして全額返金を受けられます。',
            'Retry from “My rentals”, or cancel for a full refund.',
          ),
        })
        return
      }
      setStatus({ kind: 'idle' })
      onRented()
    } catch (err) {
      setStatus({ kind: 'error', ...toFriendlyError(err) })
    }
  }

  const gpuList = (
    <VStack gap={4}>
      <SectionTitle
        step={1}
        title={t('GPU を選ぶ', 'Choose a GPU')}
        actions={<Button label={loading ? t('読み込み中…', 'Loading…') : t('一覧を更新', 'Refresh')} size="sm" variant="ghost" onClick={reload} isLoading={loading} />}
      />
      {loadError && <Banner status="error" title={loadError} />}
      {items === null && !loadError && (
        <HStack gap={2} align="center">
          <Spinner size="sm" />
          <Text color="secondary">{t('Solana から出品を読み込んでいます…', 'Loading listings from Solana…')}</Text>
        </HStack>
      )}
      {items?.length === 0 && (
        <EmptyState
          title={t('オンラインの GPU はまだありません', 'No GPUs online yet')}
          description={t('「GPU を貸す」タブの手順で、あなたの GPU を出品できます。', 'Follow the steps on the “Lend your GPU” tab to list yours.')}
          actions={<Button label={t('GPU を貸す', 'Lend your GPU')} href="#lend" />}
        />
      )}
      {items && items.length > 0 && (
        <Grid columns={{ minWidth: 240 }} gap={3}>
          {items.map((x) => {
            const { listing: l, info: i } = x
            const mine = wallet.publicKey?.equals(l.owner)
            const key = l.address.toBase58()
            const inUse = isBusy(x)
            return (
              <SelectableCard
                key={key}
                label={t(`${l.gpu} を選ぶ`, `Choose ${l.gpu}`)}
                isSelected={selected === key}
                onChange={() => setSelected(key)}
                isDisabled={busy}
              >
                <VStack gap={3}>
                  <HStack gap={2} justify="between" align="center">
                    <HStack gap={1} align="center">
                      <StatusDot variant={inUse ? 'warning' : 'success'} label={inUse ? t('使用中', 'In use') : t('空き', 'Available')} />
                      <Text type="supporting" color="secondary">
                        {inUse ? t('使用中', 'In use') : t('空き', 'Available')}
                        {mine ? t('・自分の出品', ' · Your listing') : ''}
                      </Text>
                    </HStack>
                    <Text type="supporting" color="secondary">
                      {i.backend.toUpperCase()}
                    </Text>
                  </HStack>
                  <VStack gap={0.5}>
                    <Heading level={3} maxLines={2}>
                      {l.gpu}
                    </Heading>
                    <Text type="supporting" color="secondary">
                      {l.tflops} TFLOPS ({i.dtype})
                    </Text>
                  </VStack>
                  <PriceBlock price={l.lamportsPerMinute} tflops={l.tflops} />
                  <Text type="supporting" color="secondary">
                    {t('貸し手', 'Lender')} <Code color="inherit">{shorten(l.owner.toBase58())}</Code>
                    {t(`・実績 ${l.totalRentals} 回`, ` · ${l.totalRentals} rentals`)}
                  </Text>
                </VStack>
              </SelectableCard>
            )
          })}
        </Grid>
      )}
    </VStack>
  )

  const checkout = (
    <Card padding={5}>
      <VStack gap={4}>
        <SectionTitle step={2} title={t('時間を決めてレンタル', 'Pick a duration and rent')} />
        <TextInput
          label={t('レンタル時間（分）', 'Rental time (minutes)')}
          value={minutes}
          onChange={setMinutes}
          inputMode="numeric"
          description={item ? t(`1〜${item.info.maxMinutes} 分`, `1–${item.info.maxMinutes} min`) : undefined}
          isDisabled={busy}
          autoComplete="off"
        />
        {item && (
          <MetadataList>
            <MetadataListItem label="GPU">{item.listing.gpu}</MetadataListItem>
            <MetadataListItem label={t('単価', 'Price')}>
              {lamportsToSol(item.listing.lamportsPerMinute)} {perMin()}
            </MetadataListItem>
            <MetadataListItem label={t('性能からの目安', 'Reference (by performance)')}>
              {lamportsToSol(referencePrice(item.listing.tflops))} {perMin()}
            </MetadataListItem>
            <MetadataListItem label={t('目安との差', 'vs. reference')}>
              {priceDiffLabel(item.listing.lamportsPerMinute, referencePrice(item.listing.tflops))}
            </MetadataListItem>
            <MetadataListItem label={t('受取先', 'Paid to')}>
              <Code>{shorten(item.listing.owner.toBase58())}</Code>
            </MetadataListItem>
          </MetadataList>
        )}
        <Divider />
        <HStack justify="between" align="end">
          <Text color="secondary">{t('合計（エスクローに預ける額）', 'Total (held in escrow)')}</Text>
          {item && Number.isInteger(mins) && mins > 0 ? (
            <Text size="xl" weight="bold">
              {lamportsToSol(total)} SOL
            </Text>
          ) : (
            <Text color="secondary">{t('GPU を選択', 'Choose a GPU')}</Text>
          )}
        </HStack>
        <VStack gap={2}>
          <Button
            label={busy ? t('処理中…', 'Processing…') : t('レンタルする（エスクローに預ける）', 'Rent (pay into escrow)')}
            variant="primary"
            size="lg"
            width="100%"
            onClick={rent}
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
        <Collapsible trigger={<Text weight="semibold">{t('エスクローのしくみ', 'How escrow works')}</Text>} defaultIsOpen={false}>
          <List listStyle="disc" density="compact">
            <ListItem
              label={t(
                '貸し手が 5 分以内に GPU 環境を用意できなければ、全額返金を受けられます（開始前ならいつでもキャンセル可）',
                'If the lender cannot provide the GPU environment within 5 minutes, you get a full refund (you can cancel any time before it starts)',
              )}
            />
            <ListItem label={t('利用時間は GPU 環境が使えるようになった時点から数えます', 'Your time starts when the GPU environment becomes available')} />
            <ListItem
              label={t(
                '終了後、代金はプログラムによって自動で貸し手に支払われます（貸し手が別の宛先に変えることはできません）',
                'When it ends, the program pays the lender automatically (the lender cannot redirect the payment)',
              )}
            />
            <ListItem label={t('データ置き場の保証金（約 0.003 SOL）も終了時に戻ります', 'The storage deposit (about 0.003 SOL) is returned when it ends')} />
          </List>
        </Collapsible>
      </VStack>
    </Card>
  )

  return (
    <VStack gap={6}>
      <VStack gap={4} paddingBlockStart={4}>
        <Text type="label" color="accent">
          GPU MARKET ON SOLANA DEVNET
        </Text>
        <Heading level={1} type="display-1">
          {t('余った GPU を、分単位で。', 'Spare GPUs, by the minute.')}
        </Heading>
        <Text type="large" color="secondary" weight="normal">
          {t(
            'いま貸し手のエージェントが動いている GPU です。価格は貸し手が決め、性能から算出した目安も並べて表示します。代金はプログラムのエスクローが預かります。',
            'These GPUs have a lender agent running right now. Lenders set the price, shown next to a reference price based on performance. Payment is held in the program’s escrow.',
          )}
        </Text>
        {items && items.length > 0 && (
          <HStack gap={8} wrap="wrap" paddingBlockStart={2}>
            <HeroStat label={t('オンライン', 'Online')} value={t(`${items.length} 台`, `${items.length}`)} />
            <HeroStat
              label={t('いま空き', 'Available now')}
              value={t(`${items.filter((x) => !isBusy(x)).length} 台`, `${items.filter((x) => !isBusy(x)).length}`)}
            />
            <HeroStat
              label={t('最安', 'Lowest')}
              value={`${lamportsToSol(Math.min(...items.map((x) => x.listing.lamportsPerMinute)))} ${perMin()}`}
            />
          </HStack>
        )}
      </VStack>
      <Grid columns={{ minWidth: 340, max: 2 }} gap={6} align="start">
        {gpuList}
        {checkout}
      </Grid>
    </VStack>
  )
}

/** 価格（メイン）と、その下に性能から算出した目安・目安との差 */
function PriceBlock({ price, tflops }: { price: number; tflops: number }) {
  const ref = referencePrice(tflops)
  return (
    <VStack gap={0.5}>
      <Text type="large" weight="semibold" color="accent">
        {lamportsToSol(price)} {perMin()}
      </Text>
      <Text type="supporting" color="secondary">
        {t('性能からの目安', 'Reference')} {lamportsToSol(ref)} {perMin()}
      </Text>
      <Text type="supporting" weight="semibold" color={Math.abs(price - ref) <= REFERENCE_TOLERANCE_LAMPORTS ? 'secondary' : 'primary'}>
        {priceDiffLabel(price, ref)}
      </Text>
    </VStack>
  )
}

function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <VStack gap={0.5}>
      <Text type="supporting" color="secondary">
        {label}
      </Text>
      <Text size="2xl" weight="bold">
        {value}
      </Text>
    </VStack>
  )
}
