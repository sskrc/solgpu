import { useEffect, useState } from 'react'
import { AppShell } from '@astryxdesign/core/AppShell'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Code } from '@astryxdesign/core/Code'
import { HStack } from '@astryxdesign/core/HStack'
import { Layout, LayoutContent } from '@astryxdesign/core/Layout'
import { Link } from '@astryxdesign/core/Link'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { Tab, TabList } from '@astryxdesign/core/TabList'
import { Text } from '@astryxdesign/core/Text'
import { TopNav, TopNavHeading } from '@astryxdesign/core/TopNav'
import { VStack } from '@astryxdesign/core/VStack'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { useMediaQuery } from '@astryxdesign/core/hooks'
import { WalletMenu } from './components/WalletMenu'
import { setLang, t, useLang, type Lang } from './lib/i18n'
import { PROGRAM_ID } from './lib/program'
import { connection, explorer, shorten, toFriendlyError } from './lib/solana'
import { useWallet } from './lib/useWallet'
import { Lend } from './pages/Lend'
import { Market } from './pages/Market'
import { MyRentals } from './pages/MyRentals'
import { Transfer } from './pages/Transfer'

type Tab = 'market' | 'rentals' | 'lend' | 'transfer'
const TAB_IDS: Tab[] = ['market', 'rentals', 'lend', 'transfer']
const tabLabel = (id: Tab) =>
  ({
    market: t('GPU を借りる', 'Rent a GPU'),
    rentals: t('マイレンタル', 'My rentals'),
    lend: t('GPU を貸す', 'Lend your GPU'),
    transfer: t('直接送金', 'Send SOL'),
  })[id]

/** URL の # 以降を読む（例: #lend?agent=...&code=...） */
function parseHash() {
  const [name, query = ''] = window.location.hash.replace(/^#/, '').split('?')
  const tab = (TAB_IDS.includes(name as Tab) ? name : 'market') as Tab
  return { tab, params: new URLSearchParams(query) }
}

export default function App() {
  const lang = useLang()
  const wallet = useWallet()
  const isNarrow = useMediaQuery('(max-width: 640px)')
  const [route, setRoute] = useState(parseHash)
  const [connectError, setConnectError] = useState('')
  const [rentalsKey, setRentalsKey] = useState(0)
  const [programMissing, setProgramMissing] = useState(false)

  // SolGPU プログラムがこのネットワークに存在するか確認（未デプロイなら案内を出す）
  useEffect(() => {
    connection
      .getAccountInfo(PROGRAM_ID)
      .then((a) => setProgramMissing(!a?.executable))
      .catch(() => {})
  }, [])

  useEffect(() => {
    const onHash = () => setRoute(parseHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const go = (tab: Tab) => {
    window.location.hash = tab
  }

  const connect = async () => {
    try {
      setConnectError('')
      await wallet.connect()
    } catch (err) {
      setConnectError(toFriendlyError(err).message)
    }
  }

  const walletButton = wallet.publicKey ? (
    <WalletMenu wallet={wallet} isCompact={isNarrow} />
  ) : wallet.phantom ? (
    <Button label={t('Phantom を接続', 'Connect Phantom')} variant="primary" onClick={connect} />
  ) : wallet.detected ? (
    <Button
      label={t('Phantom をインストール', 'Install Phantom')}
      variant="primary"
      href="https://phantom.com/download"
      target="_blank"
      rel="noreferrer"
    />
  ) : null

  const topNav = (
    <TopNav
      label="SolGPU"
      heading={<TopNavHeading heading="SolGPU" subheading={isNarrow ? undefined : t('みんなの GPU を SOL で貸し借り', 'Rent and lend GPUs for SOL')} headingHref="#market" />}
      endContent={
        <HStack gap={3} align="center">
          <HStack gap={1} align="center">
            <StatusDot
              variant="success"
              label={t('Devnet に接続', 'Connected to Devnet')}
              tooltip={t('Solana Devnet（テスト用ネットワーク）', 'Solana Devnet (test network)')}
            />
            {!isNarrow && (
              <Text type="supporting" color="secondary">
                Devnet
              </Text>
            )}
          </HStack>
          <SegmentedControl size="sm" label={t('表示言語', 'Language')} value={lang} onChange={(v) => setLang(v as Lang)}>
            <SegmentedControlItem value="ja" label="日本語" />
            <SegmentedControlItem value="en" label="EN" />
          </SegmentedControl>
          {walletButton}
        </HStack>
      }
    />
  )

  return (
    <AppShell topNav={topNav} height="auto" variant="section">
      <Layout height="auto" contentWidth={960} padding={4}>
        <LayoutContent isScrollable={false}>
          <VStack gap={6} paddingBlockEnd={10}>
            {connectError && <Banner status="error" title={connectError} />}
            {programMissing && (
              <Banner
                status="warning"
                title={t('SolGPU プログラムがまだ Devnet にデプロイされていません', 'The SolGPU program is not deployed on Devnet yet')}
                description={`${t('デプロイが完了するまで、出品・レンタルはできません（直接送金は使えます）。', 'Listing and renting are unavailable until it is deployed (Send SOL still works).')} Program ID: ${PROGRAM_ID.toBase58()}`}
              />
            )}

            <TabList value={route.tab} onChange={(v) => go(v as Tab)} hasDivider>
              {TAB_IDS.map((id) => (
                <Tab key={id} value={id} label={tabLabel(id)} />
              ))}
            </TabList>

            {route.tab === 'market' && (
              <Market
                wallet={wallet}
                onRented={() => {
                  setRentalsKey((k) => k + 1)
                  go('rentals')
                }}
              />
            )}
            {route.tab === 'rentals' && <MyRentals key={rentalsKey} wallet={wallet} />}
            {route.tab === 'lend' && (
              <Lend
                key={route.params.get('agent') ?? ''}
                wallet={wallet}
                agent={route.params.get('agent') ?? ''}
                code={route.params.get('code') ?? ''}
              />
            )}
            {route.tab === 'transfer' && <Transfer wallet={wallet} />}

            <Text type="supporting" color="secondary" justify="center" display="block">
              {t(
                'Solana Devnet（テスト用ネットワーク）専用のデモです。本物のお金は動きません。',
                'A demo for Solana Devnet (test network) only. No real money moves.',
              )}{' '}
              Program{' '}
              <Link href={explorer(`address/${PROGRAM_ID.toBase58()}`)} isExternalLink>
                <Code color="inherit">{shorten(PROGRAM_ID.toBase58())}</Code>
              </Link>
            </Text>
          </VStack>
        </LayoutContent>
      </Layout>
    </AppShell>
  )
}
