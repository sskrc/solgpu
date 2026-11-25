import { Fragment, useCallback, useEffect, useState } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Card } from '@astryxdesign/core/Card'
import { Code } from '@astryxdesign/core/Code'
import { CodeBlock } from '@astryxdesign/core/CodeBlock'
import { Divider } from '@astryxdesign/core/Divider'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Grid } from '@astryxdesign/core/Grid'
import { Heading } from '@astryxdesign/core/Heading'
import { HStack } from '@astryxdesign/core/HStack'
import { Link } from '@astryxdesign/core/Link'
import { Spinner } from '@astryxdesign/core/Spinner'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { Step, Stepper } from '@astryxdesign/core/Stepper'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { VStack } from '@astryxdesign/core/VStack'
import { PageHeader, SectionTitle } from '../components/PageHeader'
import { StatusBox, type Status } from '../components/StatusBox'
import { agentApi, toKey, type AgentInfo } from '../lib/market'
import {
  closeListingIx,
  createListingIx,
  fetchListings,
  fetchRental,
  randomU64,
  settleIx,
  updatePriceIx,
  type Listing,
  type Rental,
} from '../lib/program'
import {
  connection,
  explorer,
  LAMPORTS_PER_TFLOPS_MINUTE,
  lamportsToSol,
  MIN_LAMPORTS_PER_MINUTE,
  parsePrice,
  priceDiffLabel,
  referencePrice,
  shorten,
  signAndSend,
  toFriendlyError,
  transferIx,
} from '../lib/solana'
import type { Wallet } from '../lib/useWallet'

/** エージェントの手数料（利用開始・精算の記録）用に、出品時に送っておく額 */
const OPERATOR_FUND_LAMPORTS = 10_000_000 // 0.01 SOL ≒ 2,000 回分
const OPERATOR_MIN_LAMPORTS = 2_000_000

/** 数値を大きく見せる小さな統計 */
function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <VStack gap={0.5}>
      <Text type="label" color="secondary">
        {label}
      </Text>
      <Text size="xl" weight="bold">
        {value}
      </Text>
      {note && (
        <Text type="supporting" color="secondary">
          {note}
        </Text>
      )}
    </VStack>
  )
}

/** 出品価格の入力。性能からの目安と、目安との差を下に出す */
function PriceField({
  value,
  onChange,
  suggested,
  isDisabled,
  onReset,
}: {
  value: string
  onChange: (v: string) => void
  suggested: number
  isDisabled?: boolean
  onReset?: () => void
}) {
  const parsed = parsePrice(value)
  const lamports = 'lamports' in parsed ? parsed.lamports : 0
  return (
    <VStack gap={2}>
      <TextInput
        label="出品価格（SOL / 分）"
        value={value}
        onChange={onChange}
        inputMode="decimal"
        autoComplete="off"
        isDisabled={isDisabled}
        description={`目安は ${lamportsToSol(suggested)} SOL / 分（性能から算出）。自由に変えられます。`}
        status={'error' in parsed ? { type: 'error', message: parsed.error } : undefined}
      />
      {lamports > 0 && (
        <HStack gap={3} align="center" wrap="wrap">
          <Text type="supporting" color="secondary">
            1 時間 = {lamportsToSol(lamports * 60)} SOL・{priceDiffLabel(lamports, suggested)}
          </Text>
          {lamports !== suggested && onReset && (
            <Button label="目安に戻す" size="sm" variant="ghost" onClick={onReset} isDisabled={isDisabled} />
          )}
        </HStack>
      )}
    </VStack>
  )
}

/** GPU を貸す（出品と管理） */
export function Lend({ wallet, agent, code }: { wallet: Wallet; agent: string; code: string }) {
  const [info, setInfo] = useState<AgentInfo | null>(null)
  const [infoError, setInfoError] = useState('')
  const [codeError, setCodeError] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  /** 出品価格（SOL / 分）。空のあいだは性能からの目安を使う */
  const [priceInput, setPriceInput] = useState('')

  useEffect(() => {
    if (!agent) return
    let alive = true
    agentApi
      .info(agent)
      .then((i) => alive && setInfo(i))
      .catch((e) => alive && setInfoError(toFriendlyError(e).message))
    // リンクのコードが今のエージェントのものか、ページを開いた時点で確認
    if (code)
      agentApi
        .checkCode(agent, code)
        .then(() => alive && setCodeError(''))
        .catch((e) => alive && setCodeError((e as Error).message))
    return () => {
      alive = false
    }
  }, [agent, code])

  const busy = status.kind === 'busy'
  const suggested = info ? referencePrice(info.tflops) : 0
  const priceText = priceInput || (info ? lamportsToSol(suggested) : '')
  const price = parsePrice(priceText)
  const priceLamports = 'lamports' in price ? price.lamports : 0

  const list = async () => {
    if (!wallet.phantom || !wallet.publicKey || !info) return
    try {
      // 手数料を払う前に、リンクが最新か確認（古いリンクで署名してしまうのを防ぐ）
      setStatus({ kind: 'busy', message: '出品リンクを確認しています…' })
      await agentApi.checkCode(agent, code)
      if (!priceLamports) throw new Error('error' in price ? price.error : '価格を確認してください。')
      const operator = toKey(info.operator)
      const { listing, ix } = createListingIx({
        owner: wallet.publicKey,
        listingId: randomU64(),
        operator,
        agentUrl: agent,
        gpu: info.gpu,
        tflops: info.tflops,
        lamportsPerMinute: priceLamports,
      })
      const ixs = [ix]
      if ((info.operatorBalance ?? 0) < OPERATOR_MIN_LAMPORTS) {
        ixs.push(transferIx(wallet.publicKey, operator, OPERATOR_FUND_LAMPORTS))
      }
      const signature = await signAndSend(wallet.phantom, wallet.publicKey, ixs, (message) =>
        setStatus({ kind: 'busy', message }),
      )
      setStatus({ kind: 'busy', message: 'エージェントに出品を知らせています…' })
      setInfo(await agentApi.activate(agent, listing.toBase58(), code))
      wallet.refreshBalance()
      setStatus({
        kind: 'success',
        title: '出品しました',
        body: (
          <Text>
            「GPU を借りる」タブに表示されます。エージェントを動かしている間だけ貸し出され、次回からはエージェントを起動するだけで自動的に受付を再開します。
          </Text>
        ),
        signature,
      })
    } catch (err) {
      setStatus({ kind: 'error', ...toFriendlyError(err) })
    }
  }

  const alreadyListed = info?.listing && info.owner

  return (
    <VStack gap={8}>
      <PageHeader
        title="GPU を貸す"
        description="あまっている GPU を出品すると、借りた時間の分だけ SOL が届きます。"
      />

      {!agent && (
        <VStack gap={5}>
          <Stepper activeStep={0} orientation="vertical" label="出品の手順">
            <Step step={0} label="貸し出したい PC で SolGPU エージェントを起動" description="手順は README の「GPU を貸す」にあります。">
              <CodeBlock code={'cd agent\n.\\start.bat'} language="powershell" title="PowerShell" />
            </Step>
            <Step step={1} label="ベンチマークで目安の価格が決まる" description="エージェントが GPU の性能を測り、1 分あたりの目安の価格を出します。" />
            <Step step={2} label="ブラウザで出品ページが開く" description="価格は目安のままでも、自分で決めても出品できます。Phantom で「このウォレットで出品する」を承認します。" />
            <Step step={3} label="利用後、代金があなたのウォレットに届く" description="借り手の代金はプログラムのエスクローに預けられ、利用時間の終了後に支払われます。" />
          </Stepper>
          <Text type="supporting" color="secondary">
            目安の価格：計測した性能（TFLOPS）× {lamportsToSol(LAMPORTS_PER_TFLOPS_MINUTE)} SOL / 分（最低{' '}
            {lamportsToSol(MIN_LAMPORTS_PER_MINUTE)} SOL / 分）
          </Text>
          <Banner
            status="warning"
            title="借りた人は Jupyter からあなたの PC 上でプログラムを実行できます"
            description="専用フォルダで起動しますが、完全な隔離ではありません。大事なデータの無い PC で、デモの間だけ起動してください。"
          />
        </VStack>
      )}

      {agent && (
        <Card padding={5}>
          <VStack gap={5}>
            <SectionTitle title="GPU を出品する" />
            {infoError && (
              <Banner
                status="error"
                title={`エージェントに接続できません: ${infoError}`}
                description="エージェントが起動しているか確認し、表示された最新のリンクを開いてください。"
              />
            )}
            {!info && !infoError && (
              <HStack gap={2} align="center">
                <Spinner size="sm" />
                <Text color="secondary">エージェントに接続しています…</Text>
              </HStack>
            )}
            {info && (
              <>
                <Grid columns={{ minWidth: 220 }} gap={5}>
                  <Stat label="GPU" value={info.gpu} note={info.backend.toUpperCase()} />
                  <Stat label={`ベンチマーク（${info.dtype}）`} value={`${info.tflops} TFLOPS`} />
                  <Stat
                    label="性能からの目安"
                    value={`${lamportsToSol(suggested)} SOL / 分`}
                    note={`1 時間 = ${lamportsToSol(suggested * 60)} SOL`}
                  />
                </Grid>
                {!alreadyListed && (
                  <PriceField
                    value={priceText}
                    onChange={setPriceInput}
                    suggested={suggested}
                    isDisabled={busy}
                    onReset={() => setPriceInput('')}
                  />
                )}
                <Text type="supporting" color="secondary" wordBreak="break-all">
                  エージェント <Code color="inherit">{agent}</Code>
                </Text>
                <Divider />
                {alreadyListed ? (
                  <Banner
                    status="success"
                    title="このエージェントは出品済みです"
                    description={`受取ウォレット ${shorten(info.owner!)}`}
                  />
                ) : !wallet.publicKey ? (
                  <Text color="secondary" justify="center" display="block">
                    右上から Phantom を接続してください（このウォレットが受取先になります）。
                  </Text>
                ) : (
                  <Button
                    label={busy ? '処理中…' : 'このウォレットで出品する'}
                    variant="primary"
                    size="lg"
                    width="100%"
                    onClick={list}
                    isDisabled={!code || !!codeError || !priceLamports}
                    isLoading={busy}
                  />
                )}
                {codeError && !alreadyListed && <Banner status="error" title={codeError} />}
                {!code && !alreadyListed && (
                  <Banner status="error" title="リンクに認証コードがありません" description="エージェントに表示されたリンクを開いてください。" />
                )}
                {!alreadyListed && (
                  <Text type="supporting" color="secondary" justify="center" display="block">
                    出品には保証金 約 0.003 SOL（取り下げると戻ります）と、エージェントの手数料用 0.01 SOL がかかります。
                  </Text>
                )}
              </>
            )}
            <StatusBox status={status} />
          </VStack>
        </Card>
      )}

      {wallet.publicKey && <MyListings wallet={wallet} refreshKey={status.kind} />}
    </VStack>
  )
}

/** 自分の出品の一覧（取り下げ・精算） */
function MyListings({ wallet, refreshKey }: { wallet: Wallet; refreshKey: string }) {
  const [listings, setListings] = useState<{ listing: Listing; current: Rental | null }[] | null>(null)
  const [error, setError] = useState('')
  const [action, setAction] = useState<Status>({ kind: 'idle' })
  /** 価格を編集中の出品（アドレス）と入力値 */
  const [editing, setEditing] = useState<{ address: string; value: string } | null>(null)

  const load = useCallback(async () => {
    if (!wallet.publicKey) return
    try {
      const ls = await fetchListings(connection, wallet.publicKey)
      const withRental = await Promise.all(
        ls.map(async (listing) => ({
          listing,
          current: listing.openRentals > 0 ? await fetchRental(connection, listing.currentRental) : null,
        })),
      )
      setListings(withRental)
      setError('')
    } catch (e) {
      setError(toFriendlyError(e).message)
    }
  }, [wallet.publicKey])

  useEffect(() => {
    const t = setTimeout(load, 0)
    return () => clearTimeout(t)
  }, [load, refreshKey])

  const run = async (label: string, ix: Parameters<typeof signAndSend>[2][number]) => {
    if (!wallet.phantom || !wallet.publicKey) return
    try {
      const signature = await signAndSend(wallet.phantom, wallet.publicKey, [ix], (message) =>
        setAction({ kind: 'busy', message }),
      )
      setAction({ kind: 'success', title: label, signature })
      setEditing(null)
      wallet.refreshBalance()
      load()
    } catch (e) {
      setAction({ kind: 'error', ...toFriendlyError(e) })
    }
  }

  const now = Date.now() / 1000
  return (
    <VStack gap={4}>
      <SectionTitle title="あなたの出品" actions={<Button label="更新" size="sm" variant="ghost" onClick={load} />} />
      {error && <Banner status="error" title={error} />}
      {listings?.length === 0 && (
        <EmptyState isCompact title="まだ出品はありません" description="エージェントを起動すると、ここに出品が並びます。" />
      )}
      <VStack gap={4}>
        {listings?.map(({ listing: l, current }, idx) => {
          const settleable = current?.status === 'Active' && now >= current.endsAt
          const ref = referencePrice(l.tflops)
          const isEditing = editing?.address === l.address.toBase58()
          const edited = isEditing ? parsePrice(editing.value) : null
          const newPrice = edited && 'lamports' in edited ? edited.lamports : 0
          return (
            <Fragment key={l.address.toBase58()}>
              {idx > 0 && <Divider />}
              <VStack gap={3}>
                <HStack gap={3} justify="between" align="start" wrap="wrap">
                  <VStack gap={0.5}>
                    <Heading level={3}>{l.gpu}</Heading>
                    <Text type="supporting" color="secondary">
                      {lamportsToSol(l.lamportsPerMinute)} SOL / 分（{priceDiffLabel(l.lamportsPerMinute, ref)}）・レンタル実績{' '}
                      {l.totalRentals} 回・未精算 {l.openRentals} 件
                    </Text>
                  </VStack>
                  <HStack gap={1} align="center">
                    <StatusDot variant={l.active ? 'success' : 'neutral'} label={l.active ? '受付中' : '停止中'} />
                    <Text type="label">{l.active ? '受付中' : '停止中'}</Text>
                  </HStack>
                </HStack>
                {settleable && <Text>終了したレンタルの精算待ちです（{lamportsToSol(current.amount)} SOL）。</Text>}
                {isEditing && (
                  <VStack gap={3}>
                    <PriceField
                      value={editing.value}
                      onChange={(value) => setEditing({ address: editing.address, value })}
                      suggested={ref}
                      isDisabled={action.kind === 'busy'}
                      onReset={() => setEditing({ address: editing.address, value: lamportsToSol(ref) })}
                    />
                    <HStack gap={3}>
                      <Button
                        label="この価格にする"
                        size="sm"
                        variant="primary"
                        isDisabled={!newPrice || newPrice === l.lamportsPerMinute}
                        onClick={() => run('価格を変更しました', updatePriceIx(wallet.publicKey!, l, newPrice))}
                      />
                      <Button label="やめる" size="sm" variant="ghost" onClick={() => setEditing(null)} />
                    </HStack>
                  </VStack>
                )}
                <HStack gap={3} align="center" wrap="wrap">
                  {settleable && (
                    <Button label="精算する" size="sm" variant="primary" onClick={() => run('精算しました', settleIx(wallet.publicKey!, current))} />
                  )}
                  {!isEditing && (
                    <Button
                      label="価格を変える"
                      size="sm"
                      variant="secondary"
                      isDisabled={l.openRentals > 0}
                      tooltip={l.openRentals > 0 ? '未精算のレンタルがあると価格を変えられません' : undefined}
                      onClick={() => setEditing({ address: l.address.toBase58(), value: lamportsToSol(l.lamportsPerMinute) })}
                    />
                  )}
                  <Button
                    label="取り下げる"
                    size="sm"
                    variant="secondary"
                    isDisabled={l.openRentals > 0}
                    tooltip={l.openRentals > 0 ? '未精算のレンタルがあると取り下げられません' : undefined}
                    onClick={() => run('出品を取り下げました（保証金が戻りました）', closeListingIx(wallet.publicKey!, l.address))}
                  />
                  <Link href={explorer(`address/${l.address.toBase58()}`)} isExternalLink type="supporting">
                    出品アカウント
                  </Link>
                </HStack>
              </VStack>
            </Fragment>
          )
        })}
      </VStack>
      <StatusBox status={action} />
    </VStack>
  )
}
