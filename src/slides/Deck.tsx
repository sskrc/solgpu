import type { ReactNode } from 'react'
import { Card } from '@astryxdesign/core/Card'
import { Divider } from '@astryxdesign/core/Divider'
import { Grid } from '@astryxdesign/core/Grid'
import { Heading } from '@astryxdesign/core/Heading'
import { HStack } from '@astryxdesign/core/HStack'
import { Icon } from '@astryxdesign/core/Icon'
import { Link } from '@astryxdesign/core/Link'
import { List, ListItem } from '@astryxdesign/core/List'
import { Section } from '@astryxdesign/core/Section'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { Table } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import notes from './notes.json'

/**
 * 成果発表会（2026-11-26）の発表スライド。アプリと同じ Astryx の Gothic テーマで組む。
 * 1 枚 = 800×450（16:9）。pptx では 1px = 1.2pt になるので、文字はすべて xl（= 24pt）以上にする。
 * フォントは全スライド共通（テーマの本文フォントのみ。等幅フォントは使わない）。
 * 【要記入】は <Todo>。中身を書き換えたら、書き出しスクリプトで pptx / pdf を作り直す。
 */

const W = 800
const H = 450
const MAIN = 7
const PROGRAM = 'Gk1366at4C4ovkCMauacmRckfo9nbi1nyZo4rRB5Ltdt'
/** Devnet で実際に代金を預けた取引（rent_gpu）。オンチェーンの証跡としてスライド 5 に載せる */
const RENT_TX = '2UnQ2P6GQY7mCDHj78H4JkxfwJqkJuM2rY89MrJNRweSryr865vELqGmv9V872j66D6owDFJiKtjHKQScCCXWVok'
const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`

function Todo({ label }: { label: string }) {
  return (
    <Card variant="red" padding={2}>
      <Text size="xl">要記入：{label}</Text>
    </Card>
  )
}

function Slide({ no, kicker, title, children }: { no: number; kicker: string; title?: string; children: ReactNode }) {
  const appendix = no > MAIN
  return (
    <VStack as="article" width={W} height={H}>
      <Section variant="section" width={W} height={H} padding={6}>
        <VStack gap={4} height="100%">
          <HStack justify="between" align="center">
            <Text size="xl" weight="semibold" color="accent">
              {kicker}
            </Text>
            <Text size="xl" color="secondary">
              {appendix ? '付録・投影しない' : `${String(no).padStart(2, '0')} / ${String(MAIN).padStart(2, '0')}`}
            </Text>
          </HStack>
          {title && (
            <Heading level={2} type="display-2">
              {title}
            </Heading>
          )}
          {children}
        </VStack>
      </Section>
    </VStack>
  )
}

function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <List listStyle="disc" density="balanced">
      {items.map((x, i) => (
        <ListItem key={i} label={<Text size="xl">{x}</Text>} />
      ))}
    </List>
  )
}

function LinkStat({ label, text, href }: { label: string; text: string; href: string }) {
  return (
    <VStack gap={0.5}>
      <Text size="xl" color="secondary">
        {label}
      </Text>
      <Link href={href} size="xl" weight="bold">
        {text}
      </Link>
    </VStack>
  )
}

/* ---------- 1. 表紙 ---------- */
function Cover() {
  return (
    <VStack as="article" width={W} height={H}>
      <Section variant="section" width={W} height={H} padding={6}>
        <VStack gap={4} height="100%" justify="between">
          <HStack justify="between" align="center">
            <HStack gap={1} align="center">
              <StatusDot variant="success" label="Devnet" />
              <Text size="xl" color="secondary">
                SOLANA STUDENT BOOTCAMP 成果発表会 2026.11.26
              </Text>
            </HStack>
            <Text size="xl" color="secondary">
              01 / 07
            </Text>
          </HStack>
          <VStack gap={3}>
            <Heading level={1} type="display-1">
              SolGPU
            </Heading>
            <VStack gap={0}>
              <Text size="2xl" weight="semibold">
                GPU のない学生が、
              </Text>
              <Text size="2xl" weight="semibold">
                余っている誰かの GPU を分単位で借りられる
              </Text>
            </VStack>
          </VStack>
          <VStack gap={2}>
            <Divider />
            <HStack gap={2} align="center">
              <Text size="xl" color="secondary">チーム</Text>
              <Todo label="チーム名" />
            </HStack>
            <HStack gap={2} align="center">
              <Text size="xl" color="secondary">メンバー</Text>
              <Text size="xl" weight="semibold">
                佐々木理一・塩川陽太（千葉工業大学 工学部）
              </Text>
            </HStack>
            <HStack gap={2} align="center">
              <Text size="xl" color="secondary">デモ</Text>
              <Text size="xl" weight="semibold">
                sskrc.github.io/solgpu/
              </Text>
            </HStack>
          </VStack>
        </VStack>
      </Section>
    </VStack>
  )
}

/* ---------- 2. 課題 ---------- */
function Problem() {
  return (
    <Slide no={2} kicker="PROBLEM" title="GPU がなく、AI を試せない学生">
      <Grid columns={2} gap={6}>
        <Bullets
          items={[
            'GPU なしのノート PC で AI の課題に挑む工学部生',
            'CPU で長時間待つか、有料クラウドを契約',
            '一方、個人 PC の GPU は多くの時間あまり',
          ]}
        />
        <Card variant="muted" padding={6}>
          <VStack gap={3}>
            <Text size="xl" color="secondary">
              同じ計算が CPU だと
            </Text>
            <Text size="4xl" weight="bold">
              約 60 倍
            </Text>
            <Text size="xl" color="secondary">
              4096² 行列積：CPU 2.0 秒／GPU 0.03 秒（実測）
            </Text>
          </VStack>
        </Card>
      </Grid>
    </Slide>
  )
}

/* ---------- 3. 解決策 ---------- */
const SCREENS: [string, string][] = [
  ['GPU を借りる', '性能と価格の一覧'],
  ['マイレンタル', 'Jupyter を開く'],
  ['GPU を貸す', '出品の手順'],
]
function Solution() {
  return (
    <Slide no={3} kicker="SOLUTION" title="余った GPU を分単位で">
      <Grid columns={2} gap={5}>
        <Card variant="muted" padding={6}>
          <VStack gap={3}>
            <Text size="xl" weight="semibold" color="secondary">
              BEFORE
            </Text>
            <Text size="xl">相手を探す手段がない</Text>
            <Text size="xl">個人間の支払いが不安</Text>
          </VStack>
        </Card>
        <Card padding={6} elevation="low">
          <VStack gap={3}>
            <Text size="xl" weight="semibold" color="accent">
              AFTER
            </Text>
            <Text size="xl" weight="semibold">
              10〜30 秒で利用開始
            </Text>
            <Text size="xl" weight="semibold">
              代金はプログラムが保管
            </Text>
          </VStack>
        </Card>
      </Grid>
      <Grid columns={3} gap={4}>
        {SCREENS.map(([name, what]) => (
          <VStack key={name} gap={0.5}>
            <Text size="xl" weight="semibold">
              {name}
            </Text>
            <Text size="xl" color="secondary">
              {what}
            </Text>
          </VStack>
        ))}
      </Grid>
    </Slide>
  )
}

/* ---------- 4. デモ ---------- */
const DEMO_STEPS: [string, string][] = [
  ['GPU を選ぶ', 'Phantom 承認'],
  ['マイレンタル', 'Jupyter を開く'],
  ['GPU で計算', '結果を表示'],
  ['Explorer', '預け入れを確認'],
]
function Demo() {
  return (
    <Slide no={4} kicker="LIVE DEMO" title="GPU を借りて計算するまで">
      <Grid columns={4} gap={3}>
        {DEMO_STEPS.map(([t, d], i) => (
          <VStack key={t} gap={1}>
            <Text size="xl" weight="semibold" color="accent">
              STEP {i + 1}
            </Text>
            <Text size="xl" weight="bold">
              {t}
            </Text>
            <Text size="xl" color="secondary">
              {d}
            </Text>
          </VStack>
        ))}
      </Grid>
      <Card variant="yellow" padding={5}>
        <HStack gap={3} align="center">
          <Icon icon="warning" size="lg" />
          <Text size="xl">
            <Text size="xl" weight="bold">
              動かない場合
            </Text>
            ：静止画 4 枚に切り替え
          </Text>
        </HStack>
      </Card>
    </Slide>
  )
}

/* ---------- 5. なぜ Solana ---------- */
function WhySolana() {
  const boxes: [string, string, boolean][] = [
    ['借り手', '署名', false],
    ['アプリ', '送金', false],
    ['Solana', '代金を保管', true],
    ['貸し手 GPU', 'AI 計算', false],
  ]
  return (
    <Slide no={5} kicker="WHY BLOCKCHAIN" title="知らない人同士の支払いを守る">
      <VStack gap={2}>
        <HStack gap={2} align="center">
          {boxes.map(([a, b, hl], i) => (
            <HStack key={a} gap={2} align="center">
              <Card padding={3} width={156} variant={hl ? 'purple' : 'default'} elevation={hl ? 'med' : 'none'}>
                <VStack gap={0.5} hAlign="center">
                  <Text size="xl" weight="bold">
                    {a}
                  </Text>
                  <Text size="xl" color="secondary">
                    {b}
                  </Text>
                </VStack>
              </Card>
              {i < boxes.length - 1 && <Icon icon="chevronRight" size="lg" color="accent" />}
            </HStack>
          ))}
        </HStack>
      </VStack>
      <Bullets
        items={[
          '支払先・返金先は固定、未開始なら全額返金',
          `証跡：Devnet の預け入れ取引 ${short(RENT_TX)}`,
        ]}
      />
    </Slide>
  )
}

/* ---------- 6. AI 活用 ---------- */
const AI_NOTES: [string, string][] = [
  ['① 画面が AI っぽい', '→ Astryx を指定'],
  ['② デプロイ失敗', '→ 容量を広げ再実行'],
  ['開発期間 約 3 日', '11/23〜11/25'],
]
function AiUse() {
  const rows = [
    { id: 1, tool: 'Claude Code', use: 'Rust／TS／Python の実装・テスト' },
    { id: 2, tool: 'Claude Code', use: '画面の実装（デザインは Astryx を指定）' },
  ]
  return (
    <Slide no={6} kicker="AI USAGE" title="AI 活用：Claude Code で開発">
      <Table
        data={rows}
        idKey="id"
        columns={[
          { key: 'tool', header: <Text size="xl" color="secondary">ツール</Text>, width: { type: 'pixel', value: 190 }, renderCell: (r) => <Text size="xl" weight="semibold">{r.tool}</Text> },
          { key: 'use', header: <Text size="xl" color="secondary">用途</Text>, renderCell: (r) => <Text size="xl">{r.use}</Text> },
        ]}
      />
      <Grid columns={3} gap={4}>
        {AI_NOTES.map(([what, fix]) => (
          <VStack key={what} gap={1}>
            <Text size="xl" weight="semibold">
              {what}
            </Text>
            <Text size="xl" color="secondary">
              {fix}
            </Text>
          </VStack>
        ))}
      </Grid>
    </Slide>
  )
}

/* ---------- 7. 今後とリンク ---------- */
function Next() {
  return (
    <Slide no={7} kicker="NEXT" title="今後の展望とリンク">
      <Grid columns={2} gap={8}>
        <Bullets items={['GPU 利用の証明と評判', 'ベンチマークの第三者検証', '借り手のコードを隔離']} />
        <VStack gap={3}>
          <LinkStat label="デモ" text="sskrc.github.io/solgpu" href="https://sskrc.github.io/solgpu/" />
          <LinkStat label="コード" text="github.com/sskrc/solgpu" href="https://github.com/sskrc/solgpu" />
          <LinkStat
            label="Solana Explorer（Devnet）"
            text={`Program ${PROGRAM.slice(0, 6)}…${PROGRAM.slice(-5)}`}
            href={`https://explorer.solana.com/address/${PROGRAM}?cluster=devnet`}
          />
        </VStack>
      </Grid>
    </Slide>
  )
}

/* ---------- 付録: 想定 Q&A ---------- */
const QA: [string, ReactNode][] = [
  ['なぜブロックチェーンが必要？', '運営者なしで代金を預け、条件どおりに払う・返すため。普通の DB だと運営者を信頼する必要がある。'],
  ['AI にどこまで任せた？', '実装・テスト・デプロイはすべて Claude Code。UI のデザイン（Astryx の採用と見た目の方針）は自分たちで指定。'],
  ['貸し手が途中で GPU を止めたら？', '保証は「開始の記録」まで。止められても代金は支払われる。利用の証明と評判は今後。'],
  ['借り手が貸し手の PC を悪用しない？', '専用フォルダ・ターミナル無効で起動。完全な隔離ではなく、デモ用途に限定。'],
  ['価格はどう決まる？', '行列積で性能を測り、1 分 = TFLOPS × 0.000002 SOL。Arc 140T（約 13 TFLOPS）なら約 0.000026 SOL / 分。'],
]

function QaSlide({ no, part }: { no: number; part: [string, ReactNode][] }) {
  return (
    <Slide no={no} kicker="想定 Q&A">
      <VStack gap={4}>
        {part.map(([q, a]) => (
          <VStack key={q} gap={1}>
            <Text size="2xl" weight="bold" color="accent">
              Q. {q}
            </Text>
            {typeof a === 'string' ? <Text size="xl">{a}</Text> : a}
          </VStack>
        ))}
      </VStack>
    </Slide>
  )
}

export const SLIDE_COUNT = notes.length

export function Deck() {
  return (
    <>
      <Cover />
      <Problem />
      <Solution />
      <Demo />
      <WhySolana />
      <AiUse />
      <Next />
      <QaSlide no={8} part={QA.slice(0, 2)} />
      <QaSlide no={9} part={QA.slice(2, 4)} />
      <QaSlide no={10} part={QA.slice(4)} />
    </>
  )
}
