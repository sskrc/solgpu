import { DropdownMenu, DropdownMenuDivider, DropdownMenuItem } from '@astryxdesign/core/DropdownMenu'
import { HStack } from '@astryxdesign/core/HStack'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { explorer, formatSol, shorten } from '../lib/solana'
import type { Wallet } from '../lib/useWallet'

/** 上部バーの残高とウォレットメニュー（接続中のみ） */
export function WalletMenu({ wallet, isCompact = false }: { wallet: Wallet; isCompact?: boolean }) {
  if (!wallet.publicKey) return null
  const address = wallet.publicKey.toBase58()
  return (
    <HStack gap={3} align="center">
      {!isCompact && (
      <VStack gap={0} hAlign="end">
        <Text type="supporting" color="secondary">
          残高
        </Text>
        <Text weight="semibold">{wallet.balance === null ? '—' : `${formatSol(wallet.balance)} SOL`}</Text>
      </VStack>
      )}
      <DropdownMenu button={{ label: shorten(address), variant: 'secondary' }} alignment="end" menuWidth={260}>
        <DropdownMenuItem label="Solana Explorer で見る" description={shorten(address)} href={explorer(`address/${address}`)} target="_blank" icon="externalLink" />
        <DropdownMenuItem
          label="残高を更新"
          description={wallet.balance === null ? undefined : `${formatSol(wallet.balance)} SOL`}
          onClick={wallet.refreshBalance}
        />
        <DropdownMenuItem label="Faucet で Devnet SOL を入手" href="https://faucet.solana.com/" target="_blank" icon="externalLink" />
        <DropdownMenuDivider />
        <DropdownMenuItem label="切断" variant="destructive" onClick={wallet.disconnect} />
      </DropdownMenu>
    </HStack>
  )
}
