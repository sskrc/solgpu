import type { ReactNode } from 'react'
import { AspectRatio } from '@astryxdesign/core/AspectRatio'
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
import gen1 from './demo/gen1.png'
import gen2 from './demo/gen2.png'
import gen3 from './demo/gen3.png'
import gen4 from './demo/gen4.png'
import notes from './notes.json'

/**
 * 成果発表会（2026-11-26）の発表スライド。アプリと同じ Astryx の Gothic テーマで組む。
 * 日本語版と英語版（slides.html?lang=en）を同じ部品から作る。文言は下の TEXT にまとめてある。
 * 1 枚 = 800×450（16:9）。pptx では 1px = 1.2pt になるので、文字はすべて xl（= 24pt）以上にする。
 * フォントは全スライド共通（テーマの本文フォントのみ。等幅フォントは使わない）。
 * 中身を書き換えたら、書き出しスクリプトで pptx / pdf を作り直す。
 *
 * デモ（V100 を借りて画像生成）は 4 枚目で始め、5・6 枚目を話している間に生成し、7 枚目で結果を見せる。
 * 7 枚目の画像は src/slides/demo/gen*.png（Sorana発表資料/デモ/demo_cell.py で事前に生成した予備）。
 */

export type Lang = 'ja' | 'en'

const W = 800
const H = 450
const MAIN = 8
const PROGRAM = 'Gk1366at4C4ovkCMauacmRckfo9nbi1nyZo4rRB5Ltdt'
/** Devnet で実際に代金を預けた取引（rent_gpu）。オンチェーンの証跡としてスライド 5 に載せる */
const RENT_TX = '2UnQ2P6GQY7mCDHj78H4JkxfwJqkJuM2rY89MrJNRweSryr865vELqGmv9V872j66D6owDFJiKtjHKQScCCXWVok'
const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`
const GEN = [gen1, gen2, gen3, gen4]

const TEXT = {
  ja: {
    appendix: '付録・投影しない',
    event: 'SOLANA STUDENT BOOTCAMP 成果発表会 2026.11.26',
    tagline: ['GPU のない学生が、', '余っている誰かの GPU を分単位で借りられる'],
    team: 'チーム',
    members: 'メンバー',
    memberNames: '佐々木理一・塩川陽太（千葉工業大学 工学部）',
    demo: 'デモ',
    problem: {
      title: 'GPU がなく、AI を試せない学生',
      bullets: ['GPU なしのノート PC で AI の課題に挑む工学部生', 'CPU で長時間待つか、有料クラウドを契約', '一方、個人 PC の GPU は多くの時間あまり'],
      statLead: '同じ計算が CPU だと',
      stat: '約 60 倍',
      statNote: '4096² 行列積：CPU 2.0 秒／GPU 0.03 秒（実測）',
    },
    solution: {
      title: '余った GPU を分単位で',
      before: ['相手を探す手段がない', '個人間の支払いが不安'],
      after: ['10〜30 秒で利用開始', '代金はプログラムが保管'],
      screens: [
        ['GPU を借りる', '性能と価格の一覧'],
        ['マイレンタル', 'Jupyter を開く'],
        ['GPU を貸す', '出品の手順'],
      ],
    },
    demoStart: {
      title: 'V100 を借りて画像を生成',
      steps: [
        ['V100 を選ぶ', '5 分・Phantom 承認'],
        ['マイレンタル', 'Jupyter を開く'],
        ['セルを実行', '画像生成スタート'],
      ],
      later: '結果は 7 枚目で確認します',
    },
    why: {
      title: '知らない人同士の支払いを守る',
      boxes: [
        ['借り手', '署名'],
        ['アプリ', '送金'],
        ['Solana', '代金を保管'],
        ['貸し手', 'GPU で計算'],
      ],
      bullets: ['支払先・返金先は固定、未開始なら全額返金', `証跡：Devnet の預け入れ取引 ${short(RENT_TX)}`],
    },
    ai: {
      title: 'AI 活用：Claude Code で開発',
      toolHeader: 'ツール',
      useHeader: '用途',
      rows: ['Rust／TS／Python の実装・テスト', '画面の実装（デザインは Astryx を指定）'],
      notes: [
        ['① 画面が AI っぽい', '→ Astryx を指定'],
        ['② デプロイ失敗', '→ 容量を広げ再実行'],
        ['開発期間 約 3 日', '11/23〜11/25'],
      ],
    },
    result: {
      title: '生成された 4 枚の画像',
      caption: '同じコード・シードで事前生成',
      explorer: 'Explorer で取引を確認',
    },
    next: {
      title: '今後の展望とリンク',
      bullets: ['GPU 利用の証明と評判', 'ベンチマークの第三者検証', '借り手のコードを隔離'],
      code: 'コード',
    },
    qaKicker: '想定 Q&A',
    qa: [
      ['なぜブロックチェーンが必要？', '運営者なしで代金を預け、条件どおりに払う・返すため。普通の DB だと運営者を信頼する必要がある。'],
      ['AI にどこまで任せた？', '実装・テスト・デプロイはすべて Claude Code。UI のデザイン（Astryx の採用と見た目の方針）は自分たちで指定。'],
      ['貸し手が途中で GPU を止めたら？', '保証は「開始の記録」まで。止められても代金は支払われる。利用の証明と評判は今後。'],
      ['借り手が貸し手の PC を悪用しない？', '専用フォルダ・ターミナル無効で起動。完全な隔離ではなく、デモ用途に限定。'],
      ['価格はどう決まる？', '貸し手が決める。性能（TFLOPS）× 0.000002 SOL / 分の目安と、目安との差を借り手に表示。'],
    ] as [string, string][],
  },
  en: {
    appendix: 'Appendix · not shown',
    event: 'SOLANA STUDENT BOOTCAMP Demo Day 2026.11.26',
    tagline: ['Students without a GPU can rent', 'someone’s idle GPU by the minute'],
    team: 'Team',
    members: 'Members',
    memberNames: 'Riichi Sasaki, Yota Shiokawa (Chiba Tech)',
    demo: 'Demo',
    problem: {
      title: 'No GPU, no AI',
      bullets: ['Many students only have a laptop with no GPU', 'Wait for hours on a CPU, or pay for the cloud', 'Meanwhile, many home GPUs sit idle'],
      statLead: 'On a CPU, the same job is',
      stat: '60× slower',
      statNote: '4096² matmul: CPU 2.0 s / GPU 0.03 s (measured)',
    },
    solution: {
      title: 'Rent idle GPUs by the minute',
      before: ['No way to find a lender', 'Paying a stranger is risky'],
      after: ['Ready in 10–30 seconds', 'Program holds payment'],
      screens: [
        ['Rent a GPU', 'Speed and price list'],
        ['My Rentals', 'Open Jupyter'],
        ['Lend a GPU', 'How to list'],
      ],
    },
    demoStart: {
      title: 'Rent a V100, make images',
      steps: [
        ['Pick the V100', '5 min · approve'],
        ['My Rentals', 'Open Jupyter'],
        ['Run the cell', 'Start drawing'],
      ],
      later: 'We will check the result on slide 7',
    },
    why: {
      title: 'Paying strangers safely',
      boxes: [
        ['Renter', 'Signs'],
        ['Web app', 'Sends'],
        ['Solana', 'Holds SOL'],
        ['Lender', 'Runs AI'],
      ],
      bullets: ['Fixed payee and refund; full refund if not started', `Proof: Devnet deposit ${short(RENT_TX)}`],
    },
    ai: {
      title: 'Built with Claude Code',
      toolHeader: 'Tool',
      useHeader: 'Used for',
      rows: ['Rust / TS / Python code and tests', 'UI code (we chose Astryx for design)'],
      notes: [
        ['① UI looked generic', '→ Switched to Astryx'],
        ['② Deploy failed', '→ More space, retry'],
        ['About 3 days', 'Nov 23–25'],
      ],
    },
    result: {
      title: 'Four generated images',
      caption: 'Pre-made · same code & seed',
      explorer: 'Deposit on Explorer',
    },
    next: {
      title: 'What’s next',
      bullets: ['Proof of GPU use and ratings', 'Third-party benchmark checks', 'Sandbox the renter’s code'],
      code: 'Code',
    },
    qaKicker: 'Q&A',
    qa: [
      ['Why a blockchain?', 'To hold and pay money by fixed rules with no middleman. A normal database means trusting the operator.'],
      ['How much did AI do?', 'Claude Code wrote, tested and deployed the code. We chose the UI design (Astryx) ourselves.'],
      ['What if the lender stops the GPU?', 'The program only proves the session started. Proof of use and ratings come next.'],
      ['Can a renter harm the lender’s PC?', 'Jupyter runs in its own folder with no terminal. It is not a full sandbox yet.'],
      ['Who sets the price?', 'The lender. Renters also see a guide price (TFLOPS × 0.000002 SOL / min) and the difference.'],
    ] as [string, string][],
  },
}

type Copy = (typeof TEXT)['ja']

function Slide({ no, kicker, title, t, children }: { no: number; kicker: string; title?: string; t: Copy; children: ReactNode }) {
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
              {appendix ? t.appendix : `${String(no).padStart(2, '0')} / ${String(MAIN).padStart(2, '0')}`}
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

function Steps({ steps, start = 1 }: { steps: string[][]; start?: number }) {
  return (
    <Grid columns={steps.length} gap={3}>
      {steps.map(([title, detail], i) => (
        <VStack key={title} gap={1}>
          <Text size="xl" weight="semibold" color="accent">
            STEP {start + i}
          </Text>
          <Text size="xl" weight="bold">
            {title}
          </Text>
          <Text size="xl" color="secondary">
            {detail}
          </Text>
        </VStack>
      ))}
    </Grid>
  )
}

/* ---------- 1. 表紙 ---------- */
function Cover({ t }: { t: Copy }) {
  return (
    <VStack as="article" width={W} height={H}>
      <Section variant="section" width={W} height={H} padding={6}>
        <VStack gap={4} height="100%" justify="between">
          <HStack justify="between" align="center">
            <HStack gap={1} align="center">
              <StatusDot variant="success" label="Devnet" />
              <Text size="xl" color="secondary">
                {t.event}
              </Text>
            </HStack>
            <Text size="xl" color="secondary">
              01 / {String(MAIN).padStart(2, '0')}
            </Text>
          </HStack>
          <VStack gap={3}>
            <Heading level={1} type="display-1">
              SolGPU
            </Heading>
            <VStack gap={0}>
              {t.tagline.map((line) => (
                <Text key={line} size="2xl" weight="semibold">
                  {line}
                </Text>
              ))}
            </VStack>
          </VStack>
          <VStack gap={2}>
            <Divider />
            <HStack gap={2} align="center">
              <Text size="xl" color="secondary">
                {t.team}
              </Text>
              <Text size="xl" weight="semibold">
                RSSH
              </Text>
            </HStack>
            <HStack gap={2} align="center">
              <Text size="xl" color="secondary">
                {t.members}
              </Text>
              <Text size="xl" weight="semibold">
                {t.memberNames}
              </Text>
            </HStack>
            <HStack gap={2} align="center">
              <Text size="xl" color="secondary">
                {t.demo}
              </Text>
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
function Problem({ t }: { t: Copy }) {
  const p = t.problem
  return (
    <Slide no={2} kicker="PROBLEM" title={p.title} t={t}>
      <Grid columns={2} gap={6}>
        <Bullets items={p.bullets} />
        <Card variant="muted" padding={6}>
          <VStack gap={3}>
            <Text size="xl" color="secondary">
              {p.statLead}
            </Text>
            <Text size="4xl" weight="bold">
              {p.stat}
            </Text>
            <Text size="xl" color="secondary">
              {p.statNote}
            </Text>
          </VStack>
        </Card>
      </Grid>
    </Slide>
  )
}

/* ---------- 3. 解決策 ---------- */
function Solution({ t }: { t: Copy }) {
  const s = t.solution
  return (
    <Slide no={3} kicker="SOLUTION" title={s.title} t={t}>
      <Grid columns={2} gap={5}>
        <Card variant="muted" padding={6}>
          <VStack gap={3}>
            <Text size="xl" weight="semibold" color="secondary">
              BEFORE
            </Text>
            {s.before.map((x) => (
              <Text key={x} size="xl">
                {x}
              </Text>
            ))}
          </VStack>
        </Card>
        <Card padding={6} elevation="low">
          <VStack gap={3}>
            <Text size="xl" weight="semibold" color="accent">
              AFTER
            </Text>
            {s.after.map((x) => (
              <Text key={x} size="xl" weight="semibold">
                {x}
              </Text>
            ))}
          </VStack>
        </Card>
      </Grid>
      <Grid columns={3} gap={4}>
        {s.screens.map(([name, what]) => (
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

/* ---------- 4. デモ開始 ---------- */
function DemoStart({ t }: { t: Copy }) {
  const d = t.demoStart
  return (
    <Slide no={4} kicker="LIVE DEMO" title={d.title} t={t}>
      <Steps steps={d.steps} />
      <Card variant="muted" padding={5}>
        <HStack gap={3} align="center">
          <Icon icon="clock" size="lg" color="accent" />
          <Text size="xl">{d.later}</Text>
        </HStack>
      </Card>
    </Slide>
  )
}

/* ---------- 5. なぜ Solana ---------- */
function WhySolana({ t }: { t: Copy }) {
  const w = t.why
  return (
    <Slide no={5} kicker="WHY BLOCKCHAIN" title={w.title} t={t}>
      <VStack gap={2}>
        <HStack gap={2} align="center">
          {w.boxes.map(([a, b], i) => (
            <HStack key={a} gap={2} align="center">
              <Card padding={3} width={156} variant={i === 2 ? 'purple' : 'default'} elevation={i === 2 ? 'med' : 'none'}>
                <VStack gap={0.5} hAlign="center">
                  <Text size="xl" weight="bold">
                    {a}
                  </Text>
                  <Text size="xl" color="secondary">
                    {b}
                  </Text>
                </VStack>
              </Card>
              {i < w.boxes.length - 1 && <Icon icon="chevronRight" size="lg" color="accent" />}
            </HStack>
          ))}
        </HStack>
      </VStack>
      <Bullets items={w.bullets} />
    </Slide>
  )
}

/* ---------- 6. AI 活用 ---------- */
function AiUse({ t }: { t: Copy }) {
  const a = t.ai
  const rows = a.rows.map((use, i) => ({ id: i + 1, tool: 'Claude Code', use }))
  return (
    <Slide no={6} kicker="AI USAGE" title={a.title} t={t}>
      <Table
        data={rows}
        idKey="id"
        columns={[
          { key: 'tool', header: <Text size="xl" color="secondary">{a.toolHeader}</Text>, width: { type: 'pixel', value: 190 }, renderCell: (r) => <Text size="xl" weight="semibold">{r.tool}</Text> },
          { key: 'use', header: <Text size="xl" color="secondary">{a.useHeader}</Text>, renderCell: (r) => <Text size="xl">{r.use}</Text> },
        ]}
      />
      <Grid columns={3} gap={4}>
        {a.notes.map(([what, fix]) => (
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

/* ---------- 7. デモの結果 ---------- */
function DemoResult({ t, prompts }: { t: Copy; prompts: string[] }) {
  const r = t.result
  return (
    <Slide no={7} kicker="LIVE DEMO · RESULT" title={r.title} t={t}>
      <Grid columns={4} gap={3}>
        {GEN.map((src, i) => (
          <Card key={src} padding={0} elevation="low">
            <AspectRatio ratio={1} fit="cover">
              <img src={src} alt={prompts[i]} />
            </AspectRatio>
          </Card>
        ))}
      </Grid>
      <HStack justify="between" align="center">
        <Text size="xl" color="secondary">
          {r.caption}
        </Text>
        <HStack gap={1} align="center">
          <Icon icon="success" size="lg" color="accent" />
          <Text size="xl" weight="semibold">
            {r.explorer}
          </Text>
        </HStack>
      </HStack>
    </Slide>
  )
}

/* ---------- 8. 今後とリンク ---------- */
function Next({ t }: { t: Copy }) {
  const n = t.next
  return (
    <Slide no={8} kicker="NEXT" title={n.title} t={t}>
      <Grid columns={2} gap={8}>
        <Bullets items={n.bullets} />
        <VStack gap={3}>
          <LinkStat label={t.demo} text="sskrc.github.io/solgpu" href="https://sskrc.github.io/solgpu/" />
          <LinkStat label={n.code} text="github.com/sskrc/solgpu" href="https://github.com/sskrc/solgpu" />
          <LinkStat
            label="Solana Explorer (Devnet)"
            text={`Program ${PROGRAM.slice(0, 6)}…${PROGRAM.slice(-5)}`}
            href={`https://explorer.solana.com/address/${PROGRAM}?cluster=devnet`}
          />
        </VStack>
      </Grid>
    </Slide>
  )
}

/* ---------- 付録: 想定 Q&A ---------- */
function QaSlide({ no, part, t }: { no: number; part: [string, string][]; t: Copy }) {
  return (
    <Slide no={no} kicker={t.qaKicker} t={t}>
      <VStack gap={4}>
        {part.map(([q, a]) => (
          <VStack key={q} gap={1}>
            <Text size="2xl" weight="bold" color="accent">
              Q. {q}
            </Text>
            <Text size="xl">{a}</Text>
          </VStack>
        ))}
      </VStack>
    </Slide>
  )
}

/** 画像生成のプロンプト（Sorana発表資料/デモ/demo_cell.py と同じ。画像の alt に使う） */
const PROMPTS = [
  'a small robot studying at a desk at night, warm lamp light, watercolor',
  'a futuristic city skyline at sunset, purple and teal, digital art',
  'a cute cat astronaut floating in space, detailed illustration',
  'a university campus with cherry blossoms in spring, anime style',
]

export const SLIDE_COUNT = notes.ja.length

export function Deck({ lang = 'ja' }: { lang?: Lang }) {
  const t = TEXT[lang]
  return (
    <>
      <Cover t={t} />
      <Problem t={t} />
      <Solution t={t} />
      <DemoStart t={t} />
      <WhySolana t={t} />
      <AiUse t={t} />
      <DemoResult t={t} prompts={PROMPTS} />
      <Next t={t} />
      <QaSlide no={9} part={t.qa.slice(0, 2)} t={t} />
      <QaSlide no={10} part={t.qa.slice(2, 4)} t={t} />
      <QaSlide no={11} part={t.qa.slice(4)} t={t} />
    </>
  )
}
