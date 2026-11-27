import { Fragment, useCallback, useEffect, useState } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Code } from '@astryxdesign/core/Code'
import { Divider } from '@astryxdesign/core/Divider'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Heading } from '@astryxdesign/core/Heading'
import { HStack } from '@astryxdesign/core/HStack'
import { Link } from '@astryxdesign/core/Link'
import { ProgressBar } from '@astryxdesign/core/ProgressBar'
import { Spinner } from '@astryxdesign/core/Spinner'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { PageHeader } from '../components/PageHeader'
import { StatusBox, type Status } from '../components/StatusBox'
import { locale, t } from '../lib/i18n'
import { agentApi, loadRentals, toKey, type SavedRental, type SessionInfo } from '../lib/market'
import { fetchRental, fetchRentalsByRenter, refundIx, settleIx, type Rental } from '../lib/program'
import { connection, explorer, lamportsToSol, shorten, signAndSend, toFriendlyError } from '../lib/solana'
import type { Wallet } from '../lib/useWallet'

type Live = {
  chain?: Rental | null // null = オンチェーンに無い（精算・返金済み、または未払い）
  session?: SessionInfo
  fetchedAt?: number
  agentError?: string
}

type Dot = 'success' | 'warning' | 'error' | 'accent' | 'neutral'

/** 借りた GPU の一覧。Jupyter を開く・残り時間・開始の再試行・返金・精算ができる */
export function MyRentals({ wallet }: { wallet: Wallet }) {
  const [rentals, setRentals] = useState<SavedRental[]>(() => loadRentals())

  // このブラウザに記録が無くても、接続中のウォレットの未精算レンタルを Solana から探して表示する
  // （記録が消えても返金・精算ができるように）
  useEffect(() => {
    if (!wallet.publicKey) return
    let alive = true
    fetchRentalsByRenter(connection, wallet.publicKey)
      .then((onchain) => {
        if (!alive) return
        setRentals((cur) => {
          const known = new Set(cur.map((r) => r.rental))
          const extra: SavedRental[] = onchain
            .filter((c) => !known.has(c.address.toBase58()))
            .map((c) => ({
              rental: c.address.toBase58(),
              listing: c.listing.toBase58(),
              agentUrl: '',
              gpu: t('GPU（このブラウザ以外で借りたもの）', 'GPU (rented from another browser)'),
              minutes: c.minutes,
              lamports: c.amount,
              secret: '',
              createdAt: c.createdAt * 1000,
              paid: true,
            }))
          return extra.length ? [...extra, ...cur] : cur
        })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [wallet.publicKey])
  const [live, setLive] = useState<Record<string, Live>>({})
  const [now, setNow] = useState(() => Date.now())
  const [action, setAction] = useState<Record<string, Status>>({})

  const poll = useCallback(async (r: SavedRental) => {
    const chain = await fetchRental(connection, toKey(r.rental)).catch(() => undefined)
    let session: SessionInfo | undefined
    let agentError: string | undefined
    if (chain && r.secret) {
      try {
        session = await agentApi.session(r.agentUrl, r.rental, r.secret).catch(async (e) => {
          // エージェントがまだ知らない（開始前）なら、開始待ちの間だけ開始を依頼してみる
          if (chain.status === 'Pending' && chain.acceptDeadline > Date.now() / 1000) {
            return agentApi.claim(r.agentUrl, r.rental, r.secret)
          }
          throw e
        })
      } catch (e) {
        agentError = (e as Error).message
      }
    }
    setLive((s) => ({ ...s, [r.rental]: { chain, session, agentError, fetchedAt: Date.now() } }))
  }, [])

  const recent = rentals.filter((r) => Date.now() - r.createdAt < 24 * 60 * 60 * 1000)
  useEffect(() => {
    const tick = () => recent.forEach((r) => poll(r))
    const first = setTimeout(tick, 0)
    const t = setInterval(tick, 6000)
    return () => {
      clearTimeout(first)
      clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rentals, poll])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const run = async (r: SavedRental, kind: 'refund' | 'settle', chain: Rental) => {
    if (!wallet.phantom || !wallet.publicKey) {
      setAction((a) => ({ ...a, [r.rental]: { kind: 'error', message: t('ウォレットを接続してください。', 'Connect your wallet.') } }))
      return
    }
    try {
      const ix = kind === 'refund' ? refundIx(wallet.publicKey, chain) : settleIx(wallet.publicKey, chain)
      const signature = await signAndSend(wallet.phantom, wallet.publicKey, [ix], (message) =>
        setAction((a) => ({ ...a, [r.rental]: { kind: 'busy', message } })),
      )
      setAction((a) => ({
        ...a,
        [r.rental]: { kind: 'success', title: kind === 'refund' ? t('返金されました', 'Refunded') : t('精算しました', 'Settled'), signature },
      }))
      wallet.refreshBalance()
      poll(r)
    } catch (err) {
      setAction((a) => ({ ...a, [r.rental]: { kind: 'error', ...toFriendlyError(err) } }))
    }
  }

  const header = (
    <PageHeader
      title={t('マイレンタル', 'My rentals')}
      description={t(
        'GPU 環境を受け取る秘密の値はこのブラウザにだけ保存されています。返金・精算は Solana 上の記録に基づくので、どのブラウザからでもできます。',
        'The secret used to access your GPU environment is stored only in this browser. Refunds and settlement use the records on Solana, so they work from any browser.',
      )}
    />
  )

  if (rentals.length === 0) {
    return (
      <VStack gap={6}>
        {header}
        <EmptyState
          title={t('まだレンタルはありません', 'No rentals yet')}
          description={t('「GPU を借りる」タブから、空いている GPU を分単位で借りられます。', 'Rent an available GPU by the minute from the “Rent a GPU” tab.')}
          actions={<Button label={t('GPU を借りる', 'Rent a GPU')} variant="primary" href="#market" />}
        />
      </VStack>
    )
  }

  return (
    <VStack gap={6}>
      {header}
      <VStack gap={5}>
        {rentals.map((r, idx) => {
          const l = live[r.rental]
          const c = l?.chain
          const s = l?.session
          const nowSec = now / 1000
          const serverNow = s ? s.now + (now - (l?.fetchedAt ?? now)) / 1000 : nowSec
          const remaining = s?.expiresAt ? Math.max(0, Math.floor(s.expiresAt - serverNow)) : 0
          const pending = c?.status === 'Pending'
          const active = c?.status === 'Active'
          const deadlinePassed = pending && nowSec > c.acceptDeadline
          const ended = active && nowSec >= c.endsAt
          const done = l && c === null
          const isRenter = wallet.publicKey?.toBase58() === c?.renter.toBase58()

          let state: { dot: Dot; label: string; pulse?: boolean } = { dot: 'neutral', label: t('確認中', 'Checking') }
          if (done) state = { dot: 'neutral', label: r.paid ? t('完了（精算 / 返金済み）', 'Done (settled / refunded)') : t('未払い', 'Unpaid') }
          else if (pending)
            state = deadlinePassed
              ? { dot: 'error', label: t('開始されず（返金可）', 'Not started (refundable)') }
              : { dot: 'warning', label: t('開始待ち', 'Waiting to start'), pulse: true }
          else if (active && !ended) state = { dot: 'success', label: t('利用中', 'In use'), pulse: true }
          else if (ended) state = { dot: 'accent', label: t('終了（精算待ち）', 'Ended (awaiting settlement)') }

          const showJupyter = active && s?.status === 'ready' && remaining > 0
          const total = r.minutes * 60

          return (
            <Fragment key={r.rental}>
              {idx > 0 && <Divider />}
              <VStack gap={3}>
                <HStack gap={3} justify="between" align="start" wrap="wrap">
                  <VStack gap={0.5}>
                    <Heading level={3}>{r.gpu}</Heading>
                    <Text type="supporting" color="secondary">
                      {t(`${r.minutes} 分`, `${r.minutes} min`)} · {lamportsToSol(r.lamports)} SOL · {new Date(r.createdAt).toLocaleString(locale())}
                    </Text>
                  </VStack>
                  <HStack gap={1} align="center">
                    <StatusDot variant={state.dot} label={state.label} isPulsing={state.pulse} />
                    <Text type="label">{state.label}</Text>
                  </HStack>
                </HStack>

                {pending && !deadlinePassed && (
                  <HStack gap={2} align="center">
                    <Spinner size="sm" />
                    <Text color="secondary">
                      {t(
                        `貸し手が GPU 環境を準備しています（期限まで残り ${Math.max(0, Math.floor(c.acceptDeadline - nowSec))} 秒）`,
                        `The lender is preparing the GPU environment (${Math.max(0, Math.floor(c.acceptDeadline - nowSec))} s left before the deadline)`,
                      )}
                    </Text>
                  </HStack>
                )}

                {showJupyter && (
                  <VStack gap={3}>
                    <HStack gap={4} align="center" wrap="wrap">
                      <Button
                        label={t('Jupyter を開く（GPU を使う）', 'Open Jupyter (use the GPU)')}
                        variant="primary"
                        size="lg"
                        href={s.url}
                        target="_blank"
                        rel="noreferrer"
                      />
                      <Text size="2xl" weight="bold" hasTabularNumbers>
                        {t('残り', 'Left')} {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}
                      </Text>
                    </HStack>
                    <ProgressBar label={t('残り時間', 'Time left')} isLabelHidden value={remaining} max={total} variant="success" />
                    <Text type="supporting" color="secondary">
                      {t(
                        '時間になると環境は自動で停止し、ファイルは消えます。必要なものはダウンロードしておいてください。開けない（「サイトにアクセスできません」）場合は URL の準備中です。10〜30 秒待ってから再読み込みしてください。',
                        'When time is up, the environment stops and its files are deleted, so download anything you need. If it will not open (“This site can’t be reached”), the URL is still being set up: wait 10–30 seconds and reload.',
                      )}
                    </Text>
                  </VStack>
                )}

                {s?.status === 'error' && <Banner status="error" title={`${t('貸し手側でエラー', 'Error on the lender side')}: ${s.error}`} />}
                {l?.agentError && !done && (
                  <Banner
                    status="warning"
                    title={
                      /failed to fetch|タイムアウト|timed out/i.test(l.agentError)
                        ? t('貸し手のエージェントに接続できません', "Cannot reach the lender's agent")
                        : l.agentError
                    }
                  />
                )}
                {deadlinePassed && (
                  <Text>{t('貸し手が期限内に開始しなかったため、全額返金を受けられます。', 'The lender did not start in time, so you can get a full refund.')}</Text>
                )}
                {ended && <Text>{t('利用時間が終わりました。通常はエージェントが自動で精算します。', 'Your time is over. The agent usually settles automatically.')}</Text>}

                <HStack gap={3} align="center" wrap="wrap">
                  {pending && (isRenter || deadlinePassed) && (
                    <Button
                      label={deadlinePassed ? t('返金を受ける', 'Get refund') : t('キャンセルして返金', 'Cancel and refund')}
                      variant={deadlinePassed ? 'primary' : 'secondary'}
                      size="sm"
                      onClick={() => run(r, 'refund', c)}
                    />
                  )}
                  {ended && <Button label={t('精算する', 'Settle')} size="sm" onClick={() => run(r, 'settle', c)} />}
                  <Link href={explorer(`address/${r.rental}`)} isExternalLink type="supporting">
                    {t('エスクロー', 'Escrow')} <Code color="inherit">{shorten(r.rental)}</Code>
                  </Link>
                </HStack>
                <StatusBox status={action[r.rental] ?? { kind: 'idle' }} />
              </VStack>
            </Fragment>
          )
        })}
      </VStack>
    </VStack>
  )
}
