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
import { agentApi, loadMarket, randomSecret, saveRental, sha256, type MarketItem } from '../lib/market'
import { randomU64, rentIx } from '../lib/program'
import {
  FEE_BUFFER_LAMPORTS,
  LAMPORTS_PER_SOL,
  lamportsToSol,
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
    if (!wallet.publicKey) return 'まずウォレットを接続してください。'
    if (!item) return 'GPU を選んでください。'
    if (item.listing.owner.equals(wallet.publicKey)) return '自分が出品した GPU は借りられません。'
    if (isBusy(item)) return 'この GPU は使用中です。'
    if (!Number.isInteger(mins) || mins < 1 || mins > item.info.maxMinutes)
      return `レンタル時間は 1〜${item.info.maxMinutes} 分で指定してください。`
    if (wallet.balance !== null && total + 3_000_000 + FEE_BUFFER_LAMPORTS > wallet.balance * LAMPORTS_PER_SOL)
      return '残高が足りません（代金 + 一時的な保証金 約 0.003 SOL + 手数料が必要です）。'
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
      // 1. 代金をエスクロー（Amari プログラムの口座）に預ける
      try {
        await signAndSend(wallet.phantom, wallet.publicKey, [ix], (message) => setStatus({ kind: 'busy', message }))
      } catch (err) {
        if (err instanceof SentButUnconfirmedError) {
          throw new Error('送信済みですが完了を確認できませんでした。「マイレンタル」タブで状態を確認してください。')
        }
        throw err
      }
      saveRental({ ...saved, paid: true })
      wallet.refreshBalance()

      // 2. 貸し手のエージェントに開始を依頼（エージェントが準備できたらオンチェーンで「開始」が記録される）
      setStatus({ kind: 'busy', message: '貸し手のエージェントが GPU 環境を準備しています…' })
      try {
        await agentApi.claim(info.agentUrl, rental.toBase58(), secret)
      } catch (err) {
        setStatus({
          kind: 'error',
          message: `代金はエスクローに預けられましたが、開始の依頼に失敗しました: ${(err as Error).message}`,
          detail: '「マイレンタル」から再試行するか、キャンセルして全額返金を受けられます。',
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
        title="GPU を選ぶ"
        actions={<Button label={loading ? '読み込み中…' : '一覧を更新'} size="sm" variant="ghost" onClick={reload} isLoading={loading} />}
      />
      {loadError && <Banner status="error" title={loadError} />}
      {items === null && !loadError && (
        <HStack gap={2} align="center">
          <Spinner size="sm" />
          <Text color="secondary">Solana から出品を読み込んでいます…</Text>
        </HStack>
      )}
      {items?.length === 0 && (
        <EmptyState
          title="オンラインの GPU はまだありません"
          description="「GPU を貸す」タブの手順で、あなたの GPU を出品できます。"
          actions={<Button label="GPU を貸す" href="#lend" />}
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
                label={`${l.gpu} を選ぶ`}
                isSelected={selected === key}
                onChange={() => setSelected(key)}
                isDisabled={busy}
              >
                <VStack gap={3}>
                  <HStack gap={2} justify="between" align="center">
                    <HStack gap={1} align="center">
                      <StatusDot variant={inUse ? 'warning' : 'success'} label={inUse ? '使用中' : '空き'} />
                      <Text type="supporting" color="secondary">
                        {inUse ? '使用中' : '空き'}
                        {mine ? '・自分の出品' : ''}
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
                      {l.tflops} TFLOPS（{i.dtype}）
                    </Text>
                  </VStack>
                  <Text type="large" weight="semibold" color="accent">
                    {lamportsToSol(l.lamportsPerMinute)} SOL / 分
                  </Text>
                  <Text type="supporting" color="secondary">
                    貸し手 <Code color="inherit">{shorten(l.owner.toBase58())}</Code>・実績 {l.totalRentals} 回
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
        <SectionTitle step={2} title="時間を決めてレンタル" />
        <TextInput
          label="レンタル時間（分）"
          value={minutes}
          onChange={setMinutes}
          inputMode="numeric"
          description={item ? `1〜${item.info.maxMinutes} 分` : undefined}
          isDisabled={busy}
          autoComplete="off"
        />
        {item && (
          <MetadataList>
            <MetadataListItem label="GPU">{item.listing.gpu}</MetadataListItem>
            <MetadataListItem label="単価">{lamportsToSol(item.listing.lamportsPerMinute)} SOL / 分</MetadataListItem>
            <MetadataListItem label="受取先">
              <Code>{shorten(item.listing.owner.toBase58())}</Code>
            </MetadataListItem>
          </MetadataList>
        )}
        <Divider />
        <HStack justify="between" align="end">
          <Text color="secondary">合計（エスクローに預ける額）</Text>
          {item && Number.isInteger(mins) && mins > 0 ? (
            <Text size="xl" weight="bold">
              {lamportsToSol(total)} SOL
            </Text>
          ) : (
            <Text color="secondary">GPU を選択</Text>
          )}
        </HStack>
        <VStack gap={2}>
          <Button
            label={busy ? '処理中…' : 'レンタルする（エスクローに預ける）'}
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
        <Collapsible trigger={<Text weight="semibold">エスクローのしくみ</Text>} defaultIsOpen={false}>
          <List listStyle="disc" density="compact">
            <ListItem label="貸し手が 5 分以内に GPU 環境を用意できなければ、全額返金を受けられます（開始前ならいつでもキャンセル可）" />
            <ListItem label="利用時間は GPU 環境が使えるようになった時点から数えます" />
            <ListItem label="終了後、代金はプログラムによって自動で貸し手に支払われます（貸し手が別の宛先に変えることはできません）" />
            <ListItem label="データ置き場の保証金（約 0.003 SOL）も終了時に戻ります" />
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
          余った GPU を、分単位で。
        </Heading>
        <Text type="large" color="secondary" weight="normal">
          いま貸し手のエージェントが動いている GPU です。価格はベンチマーク結果から自動で決まり、代金はプログラムのエスクローが預かります。
        </Text>
        {items && items.length > 0 && (
          <HStack gap={8} wrap="wrap" paddingBlockStart={2}>
            <HeroStat label="オンライン" value={`${items.length} 台`} />
            <HeroStat label="いま空き" value={`${items.filter((x) => !isBusy(x)).length} 台`} />
            <HeroStat
              label="最安"
              value={`${lamportsToSol(Math.min(...items.map((x) => x.listing.lamportsPerMinute)))} SOL / 分`}
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
