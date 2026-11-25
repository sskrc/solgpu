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
import { useMediaQuery } from '@astryxdesign/core/hooks'
import { WalletMenu } from './components/WalletMenu'
import { PROGRAM_ID } from './lib/program'
import { connection, explorer, shorten, toFriendlyError } from './lib/solana'
import { useWallet } from './lib/useWallet'
import { Lend } from './pages/Lend'
import { Market } from './pages/Market'
import { MyRentals } from './pages/MyRentals'
import { Transfer } from './pages/Transfer'

type Tab = 'market' | 'rentals' | 'lend' | 'transfer'
const TABS: { id: Tab; label: string }[] = [
  { id: 'market', label: 'GPU を借りる' },
  { id: 'rentals', label: 'マイレンタル' },
  { id: 'lend', label: 'GPU を貸す' },
  { id: 'transfer', label: '直接送金' },
]

/** URL の # 以降を読む（例: #lend?agent=...&code=...） */
function parseHash() {
  const [name, query = ''] = window.location.hash.replace(/^#/, '').split('?')
  const tab = (TABS.some((t) => t.id === name) ? name : 'market') as Tab
  return { tab, params: new URLSearchParams(query) }
}

export default function App() {
  const wallet = useWallet()
  const isNarrow = useMediaQuery('(max-width: 640px)')
  const [route, setRoute] = useState(parseHash)
  const [connectError, setConnectError] = useState('')
  const [rentalsKey, setRentalsKey] = useState(0)
  const [programMissing, setProgramMissing] = useState(false)

  // Amari プログラムがこのネットワークに存在するか確認（未デプロイなら案内を出す）
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
    <Button label="Phantom を接続" variant="primary" onClick={connect} />
  ) : wallet.detected ? (
    <Button
      label="Phantom をインストール"
      variant="primary"
      href="https://phantom.com/download"
      target="_blank"
      rel="noreferrer"
    />
  ) : null

  const topNav = (
    <TopNav
      label="Amari"
      heading={<TopNavHeading heading="Amari" subheading={isNarrow ? undefined : 'みんなの GPU を SOL で貸し借り'} headingHref="#market" />}
      endContent={
        <HStack gap={3} align="center">
          <HStack gap={1} align="center">
            <StatusDot variant="success" label="Devnet に接続" tooltip="Solana Devnet（テスト用ネットワーク）" />
            {!isNarrow && (
              <Text type="supporting" color="secondary">
                Devnet
              </Text>
            )}
          </HStack>
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
                title="Amari プログラムがまだ Devnet にデプロイされていません"
                description={`デプロイが完了するまで、出品・レンタルはできません（直接送金は使えます）。Program ID: ${PROGRAM_ID.toBase58()}`}
              />
            )}

            <TabList value={route.tab} onChange={(v) => go(v as Tab)} hasDivider>
              {TABS.map((t) => (
                <Tab key={t.id} value={t.id} label={t.label} />
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
              Solana Devnet（テスト用ネットワーク）専用のデモです。本物のお金は動きません。 Program{' '}
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
