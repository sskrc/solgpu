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
import { t } from '../lib/i18n'
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

/** エージェントのソースコード（貸し手はここからクローンして準備する） */
const REPO_URL = 'https://github.com/sskrc/solgpu'
const setupWindows = () => `git clone ${REPO_URL}.git
cd solgpu\\agent
.\\setup.bat nvidia  # ${t('Intel Arc なら intel、GPU なしなら cpu', 'intel for Intel Arc, cpu without a GPU')}`
const setupLinux = () => `git clone ${REPO_URL}.git
cd solgpu/agent
bash setup.sh nvidia   # ${t('V100 など古い NVIDIA も自動で対応。GPU なしなら cpu', 'older NVIDIA (V100 etc.) OK; cpu if no GPU')}`

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
        label={t('出品価格（SOL / 分）', 'Price (SOL / min)')}
        value={value}
        onChange={onChange}
        inputMode="decimal"
        autoComplete="off"
        isDisabled={isDisabled}
        description={t(
          `目安は ${lamportsToSol(suggested)} SOL / 分（性能から算出）。自由に変えられます。`,
          `Reference: ${lamportsToSol(suggested)} SOL / min (from performance). You can set any price.`,
        )}
        status={'error' in parsed ? { type: 'error', message: parsed.error } : undefined}
      />
      {lamports > 0 && (
        <HStack gap={3} align="center" wrap="wrap">
          <Text type="supporting" color="secondary">
            {t('1 時間', '1 hour')} = {lamportsToSol(lamports * 60)} SOL · {priceDiffLabel(lamports, suggested)}
          </Text>
          {lamports !== suggested && onReset && (
            <Button label={t('目安に戻す', 'Use reference')} size="sm" variant="ghost" onClick={onReset} isDisabled={isDisabled} />
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
      setStatus({ kind: 'busy', message: t('出品リンクを確認しています…', 'Checking the listing link…') })
      await agentApi.checkCode(agent, code)
      if (!priceLamports) throw new Error('error' in price ? price.error : t('価格を確認してください。', 'Check the price.'))
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
      setStatus({ kind: 'busy', message: t('エージェントに出品を知らせています…', 'Telling the agent about the listing…') })
      setInfo(await agentApi.activate(agent, listing.toBase58(), code))
      wallet.refreshBalance()
      setStatus({
        kind: 'success',
        title: t('出品しました', 'Listed'),
        body: (
          <Text>
            {t(
              '「GPU を借りる」タブに表示されます。エージェントを動かしている間だけ貸し出され、次回からはエージェントを起動するだけで自動的に受付を再開します。',
              'It now appears on the “Rent a GPU” tab. It is rentable only while the agent runs; next time, just start the agent and it accepts rentals again automatically.',
            )}
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
        title={t('GPU を貸す', 'Lend your GPU')}
        description={t(
          'あまっている GPU を出品すると、借りた時間の分だけ SOL が届きます。',
          'List your idle GPU and receive SOL for every minute it is rented.',
        )}
      />

      {!agent && (
        <VStack gap={5}>
          <Stepper activeStep={0} orientation="vertical" label={t('出品の手順', 'Steps to list')}>
            <Step
              step={0}
              label={t('GitHub からクローンして準備する（最初の 1 回だけ）', 'Clone from GitHub and set up (first time only)')}
              description={t(
                'Git と Python 3.10〜3.12、GPU の最新ドライバが必要です。setup が PyTorch などを入れます（数 GB）。GPU の種類に合わせて intel / nvidia / cpu を指定します。',
                'You need Git, Python 3.10–3.12 and an up-to-date GPU driver. Setup installs PyTorch and more (several GB). Pass intel / nvidia / cpu to match your GPU.',
              )}
            >
              <VStack gap={3}>
                <CodeBlock code={setupWindows()} language="powershell" title="Windows (PowerShell)" />
                <CodeBlock code={setupLinux()} language="bash" title="Linux / macOS" />
                <Text type="supporting" color="secondary">
                  {t('Windows ではインターネット公開用の cloudflared も入れてください（', 'On Windows, also install cloudflared to expose the agent to the internet (')}
                  <Code>winget install --id Cloudflare.cloudflared -e</Code>
                  {t('）。Linux では setup.sh が自動で入れます。詳しくは', '). On Linux, setup.sh installs it for you. See')}{' '}
                  <Link
                    href={t(`${REPO_URL}#3-gpu-を貸す貸し手`, `${REPO_URL}/blob/main/README.en.md#3-lend-a-gpu-lender`)}
                    isExternalLink
                    type="supporting"
                  >
                    {t('README の「GPU を貸す」', '“Lend a GPU” in the README')}
                  </Link>
                  {t('。', ' for details.')}
                </Text>
              </VStack>
            </Step>
            <Step
              step={1}
              label={t('エージェントを起動する', 'Start the agent')}
              description={t(
                'クローンした solgpu/agent フォルダで実行します。次回からはこれだけで受付を再開します。停止は Ctrl + C。',
                'Run it in the cloned solgpu/agent folder. From then on, this is all you need to start accepting rentals. Stop with Ctrl + C.',
              )}
            >
              <VStack gap={3}>
                <CodeBlock code={'.\\start.bat'} language="powershell" title="Windows (PowerShell)" />
                <CodeBlock code={'.venv/bin/python solgpu_agent.py --i-understand-the-risk'} language="bash" title="Linux / macOS" />
              </VStack>
            </Step>
            <Step
              step={2}
              label={t('ベンチマークで目安の価格が決まる', 'A benchmark sets the reference price')}
              description={t('エージェントが GPU の性能を測り、1 分あたりの目安の価格を出します。', "The agent measures your GPU's performance and suggests a price per minute.")}
            />
            <Step
              step={3}
              label={t('ブラウザで出品ページが開く', 'The listing page opens in your browser')}
              description={t(
                '価格は目安のままでも、自分で決めても出品できます。Phantom で「このウォレットで出品する」を承認します。',
                'Keep the reference price or set your own, then approve “List with this wallet” in Phantom.',
              )}
            />
            <Step
              step={4}
              label={t('利用後、代金があなたのウォレットに届く', 'After use, payment arrives in your wallet')}
              description={t(
                '借り手の代金はプログラムのエスクローに預けられ、利用時間の終了後に支払われます。',
                "The renter's payment is held in the program's escrow and paid out when the rental ends.",
              )}
            />
          </Stepper>
          <Text type="supporting" color="secondary">
            {t(
              `目安の価格：計測した性能（TFLOPS）× ${lamportsToSol(LAMPORTS_PER_TFLOPS_MINUTE)} SOL / 分（最低 ${lamportsToSol(MIN_LAMPORTS_PER_MINUTE)} SOL / 分）`,
              `Reference price: measured performance (TFLOPS) × ${lamportsToSol(LAMPORTS_PER_TFLOPS_MINUTE)} SOL / min (minimum ${lamportsToSol(MIN_LAMPORTS_PER_MINUTE)} SOL / min)`,
            )}
          </Text>
          <Banner
            status="warning"
            title={t('借りた人は Jupyter からあなたの PC 上でプログラムを実行できます', 'Renters can run code on your PC through Jupyter')}
            description={t(
              '専用フォルダで起動しますが、完全な隔離ではありません。大事なデータの無い PC で、デモの間だけ起動してください。',
              'It runs in a dedicated folder but is not fully isolated. Run it only during the demo, on a PC without important data.',
            )}
          />
        </VStack>
      )}

      {agent && (
        <Card padding={5}>
          <VStack gap={5}>
            <SectionTitle title={t('GPU を出品する', 'List your GPU')} />
            {infoError && (
              <Banner
                status="error"
                title={`${t('エージェントに接続できません', 'Cannot connect to the agent')}: ${infoError}`}
                description={t(
                  'エージェントが起動しているか確認し、表示された最新のリンクを開いてください。',
                  'Make sure the agent is running and open the latest link it printed.',
                )}
              />
            )}
            {!info && !infoError && (
              <HStack gap={2} align="center">
                <Spinner size="sm" />
                <Text color="secondary">{t('エージェントに接続しています…', 'Connecting to the agent…')}</Text>
              </HStack>
            )}
            {info && (
              <>
                <Grid columns={{ minWidth: 220 }} gap={5}>
                  <Stat label="GPU" value={info.gpu} note={info.backend.toUpperCase()} />
                  <Stat label={`${t('ベンチマーク', 'Benchmark')} (${info.dtype})`} value={`${info.tflops} TFLOPS`} />
                  <Stat
                    label={t('性能からの目安', 'Reference price')}
                    value={`${lamportsToSol(suggested)} ${t('SOL / 分', 'SOL / min')}`}
                    note={`${t('1 時間', '1 hour')} = ${lamportsToSol(suggested * 60)} SOL`}
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
                  {t('エージェント', 'Agent')} <Code color="inherit">{agent}</Code>
                </Text>
                <Divider />
                {alreadyListed ? (
                  <Banner
                    status="success"
                    title={t('このエージェントは出品済みです', 'This agent is already listed')}
                    description={`${t('受取ウォレット', 'Payout wallet')} ${shorten(info.owner!)}`}
                  />
                ) : !wallet.publicKey ? (
                  <Text color="secondary" justify="center" display="block">
                    {t(
                      '右上から Phantom を接続してください（このウォレットが受取先になります）。',
                      'Connect Phantom at the top right (this wallet receives the payments).',
                    )}
                  </Text>
                ) : (
                  <Button
                    label={busy ? t('処理中…', 'Processing…') : t('このウォレットで出品する', 'List with this wallet')}
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
                  <Banner
                    status="error"
                    title={t('リンクに認証コードがありません', 'The link has no verification code')}
                    description={t('エージェントに表示されたリンクを開いてください。', 'Open the link printed by the agent.')}
                  />
                )}
                {!alreadyListed && (
                  <Text type="supporting" color="secondary" justify="center" display="block">
                    {t(
                      '出品には保証金 約 0.003 SOL（取り下げると戻ります）と、エージェントの手数料用 0.01 SOL がかかります。',
                      "Listing costs a deposit of about 0.003 SOL (returned when you remove it) plus 0.01 SOL for the agent's fees.",
                    )}
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
      <SectionTitle
        title={t('あなたの出品', 'Your listings')}
        actions={<Button label={t('更新', 'Refresh')} size="sm" variant="ghost" onClick={load} />}
      />
      {error && <Banner status="error" title={error} />}
      {listings?.length === 0 && (
        <EmptyState
          isCompact
          title={t('まだ出品はありません', 'No listings yet')}
          description={t('エージェントを起動すると、ここに出品が並びます。', 'Start the agent and your listings will show up here.')}
        />
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
                      {lamportsToSol(l.lamportsPerMinute)} {t('SOL / 分', 'SOL / min')} ({priceDiffLabel(l.lamportsPerMinute, ref)}) ·{' '}
                      {t(
                        `レンタル実績 ${l.totalRentals} 回・未精算 ${l.openRentals} 件`,
                        `${l.totalRentals} rentals · ${l.openRentals} unsettled`,
                      )}
                    </Text>
                  </VStack>
                  <HStack gap={1} align="center">
                    <StatusDot variant={l.active ? 'success' : 'neutral'} label={l.active ? t('受付中', 'Accepting') : t('停止中', 'Paused')} />
                    <Text type="label">{l.active ? t('受付中', 'Accepting') : t('停止中', 'Paused')}</Text>
                  </HStack>
                </HStack>
                {settleable && (
                  <Text>
                    {t(
                      `終了したレンタルの精算待ちです（${lamportsToSol(current.amount)} SOL）。`,
                      `A finished rental is waiting to be settled (${lamportsToSol(current.amount)} SOL).`,
                    )}
                  </Text>
                )}
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
                        label={t('この価格にする', 'Use this price')}
                        size="sm"
                        variant="primary"
                        isDisabled={!newPrice || newPrice === l.lamportsPerMinute}
                        onClick={() => run(t('価格を変更しました', 'Price updated'), updatePriceIx(wallet.publicKey!, l, newPrice))}
                      />
                      <Button label={t('やめる', 'Cancel')} size="sm" variant="ghost" onClick={() => setEditing(null)} />
                    </HStack>
                  </VStack>
                )}
                <HStack gap={3} align="center" wrap="wrap">
                  {settleable && (
                    <Button label={t('精算する', 'Settle')} size="sm" variant="primary" onClick={() => run(t('精算しました', 'Settled'), settleIx(wallet.publicKey!, current))} />
                  )}
                  {!isEditing && (
                    <Button
                      label={t('価格を変える', 'Change price')}
                      size="sm"
                      variant="secondary"
                      isDisabled={l.openRentals > 0}
                      tooltip={l.openRentals > 0 ? t('未精算のレンタルがあると価格を変えられません', 'You cannot change the price while rentals are unsettled') : undefined}
                      onClick={() => setEditing({ address: l.address.toBase58(), value: lamportsToSol(l.lamportsPerMinute) })}
                    />
                  )}
                  <Button
                    label={t('取り下げる', 'Remove')}
                    size="sm"
                    variant="secondary"
                    isDisabled={l.openRentals > 0}
                    tooltip={l.openRentals > 0 ? t('未精算のレンタルがあると取り下げられません', 'You cannot remove it while rentals are unsettled') : undefined}
                    onClick={() => run(t('出品を取り下げました（保証金が戻りました）', 'Listing removed (deposit returned)'), closeListingIx(wallet.publicKey!, l.address))}
                  />
                  <Link href={explorer(`address/${l.address.toBase58()}`)} isExternalLink type="supporting">
                    {t('出品アカウント', 'Listing account')}
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
