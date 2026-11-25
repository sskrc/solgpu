# SolGPU — みんなの GPU を SOL で貸し借り（Solana Devnet・エスクロー付き）

AI 需要で GPU が足りない一方、個人の PC の GPU は多くの時間あまっています。
SolGPU は **誰でも自分の GPU を出品でき、誰でも分単位で借りられる** GPU マーケットプレイスです。
出品とレンタルは **Anchor で書いた Solana プログラム** が管理し、代金は **エスクロー** で守られます。

- 貸し手: エージェントを起動 → **ベンチマークで性能を測定し価格を自動決定** → Phantom で出品
- 借り手: 一覧から GPU を選ぶ → 分数を指定 → 代金をエスクローに預ける → **ブラウザの Jupyter Lab でその GPU が使える**
- 終了後、代金はプログラムが貸し手に支払う。貸し手が開始しなければ **全額返金**

> ⚠️ **Devnet（テスト用ネットワーク）専用** です。本物の SOL は動きません。

---

## 仕組み

```
 貸し手の PC                          SolGPU プログラム (Solana Devnet)              借り手のブラウザ
┌───────────────────────┐          ┌──────────────────────────────┐          ┌──────────────────┐
│ SolGPU エージェント     │          │ Listing（出品）                │ ◀─ 一覧 ─ │ SolGPU Web アプリ │
│  ・ベンチマーク          │          │   受取先・価格・エージェントURL  │          │ (GitHub Pages)    │
│  ・operator 鍵          │ ─accept─▶ │ Rental（エスクロー口座）       │ ◀─ 預金 ─ │  Phantom で署名   │
│  ・Jupyter 起動/停止     │ ─settle─▶ │   代金を預かり、終了後に貸し手へ │ ─ 返金 ─▶ │                  │
│                       │ ◀──────── 開始依頼（秘密の値） / Jupyter の URL（HTTPS, Cloudflare Tunnel）──────── │
└───────────────────────┘          └──────────────────────────────┘          └──────────────────┘
```

### プログラムの命令（`program/programs/sorana-market/src`）

| 命令 | 誰が | 何をする |
| --- | --- | --- |
| `create_listing` | 貸し手 | 出品を作る（受取ウォレット・エージェントの鍵・URL・GPU 名・性能・価格） |
| `update_agent` | 貸し手 / エージェント | エージェントの URL と受付状態を更新（エージェント起動・停止時に自動） |
| `update_listing` | 貸し手 | 価格・性能・エージェントの鍵を変更（未精算のレンタルが無いとき） |
| `close_listing` | 貸し手 | 出品を取り下げ、保証金を回収（未精算のレンタルが無いとき） |
| `rent_gpu` | 借り手 | 代金（価格 × 分）を **エスクロー口座** に預ける。GPU は 5 分間「開始待ち」で確保される |
| `accept` | エージェント | Jupyter の準備ができたら「利用開始」を記録。ここから時間を数える |
| `settle` | 誰でも | 終了時刻を過ぎたら精算。代金は **必ず貸し手** へ、口座の保証金は借り手へ |
| `refund` | 借り手はいつでも / 他の人は期限後 | 開始されていないレンタルを取り消し。代金は **必ず借り手** へ |

### 安全のための工夫

- **お金の行き先はプログラムが固定**: 精算は出品時の受取ウォレットへ、返金は借り手へ。エージェントの鍵が盗まれても代金は動かせません
- **価格はプログラムが計算**: `価格 × 分` をオンチェーンで計算し、借り手が画面で見た価格と違えば失敗します
- **1 台に 1 人**: 開始待ち・利用中は他の人が借りられません（`busy_until`）
- **開始されなければ返金**: エージェントが 5 分以内に `accept` しなければ、誰でも返金を実行でき、代金は借り手に戻ります
- **精算は誰でも実行可能**: エージェントが止まっても、終了後に借り手・貸し手のどちらでも精算ボタンを押せます
- **本人確認**: 借り手だけが知る秘密の値のハッシュをレンタル口座に保存。エージェントは秘密の値が一致した人にだけ Jupyter の URL を渡します
- **乗っ取り防止**: エージェントは自分の出品リンク（使い捨てコード）で作られた出品にだけ紐付き、一覧にはエージェント自身が認めた出品だけが表示されます

### 正直に書いておくこと（デモの制約）

- **GPU が本当に使えたかまでは証明できません**: プログラムが確認できるのは「エージェントが開始を記録した」ことまでです。開始後に貸し手が GPU を止めても、代金は貸し手に支払われます（評判システムや、利用状況の証明は今後の課題）
- **ベンチマークは自己申告**: エージェントが測った値をそのまま使います
- **Cloudflare Tunnel** という中央のサービスを経由しています
- 借り手の PC からは、ブラウザに保存した秘密の値で GPU 環境を受け取ります。ブラウザのデータを消すと Jupyter は開けません（返金・精算はどのブラウザからでも可能）

### 価格の決め方

エージェントが PyTorch で行列積（GPU は fp16、CPU は fp32）を実行し、性能を TFLOPS で測ります。

```
1 分あたりの価格 = 計測 TFLOPS × 0.000002 SOL（最低 0.00001 SOL / 分）
```

例: Intel Arc 140T（約 13 TFLOPS）→ 約 0.000026 SOL / 分（1 時間 約 0.0016 SOL）

---

## ファイル構成

| パス | 内容 |
| --- | --- |
| `program/` | **Anchor プログラム**（Rust）とテスト |
| `program/programs/sorana-market/src/instructions/` | 出品・レンタル・エスクローの各命令 |
| `program/programs/sorana-market/tests/test_market.rs` | テスト（成功の流れ・不正操作・期限切れ返金など） |
| `program/build.sh` | ビルド・テスト・デプロイ（WSL / Linux） |
| `src/lib/program.ts` | Web アプリからプログラムを呼ぶ部分 |
| `src/pages/Market.tsx` | GPU を借りる |
| `src/pages/MyRentals.tsx` | マイレンタル（Jupyter を開く・返金・精算） |
| `src/pages/Lend.tsx` | GPU を貸す（出品・取り下げ・精算） |
| `src/pages/Transfer.tsx` | 直接送金（アドレスと数量を指定して SOL を送る） |
| `src/astryx-themes.ts` | 画面のテーマ（[Astryx](https://www.npmjs.com/package/@astryxdesign/core) の Gothic。`npx astryx theme` が生成） |
| `src/slides/` / `slides.html` | 発表スライド（アプリと同じ Astryx で作成）。本文は `Deck.tsx`、発表原稿は `notes.json` |
| `scripts/export-slides.mjs` | 発表スライドを PDF / PowerPoint に書き出す（`npm run slides:export`） |
| `agent/sorana_agent.py` | 貸し手エージェント本体 |
| `agent/chain.py` | エージェントからプログラムを呼ぶ部分（accept / settle） |
| `agent/runtime.py` | ベンチマーク・Jupyter・トンネル・プロセス管理 |
| `scripts/e2e-local.ts` | ローカル validator での通しテスト |
| `.github/workflows/deploy.yml` | GitHub Pages への自動公開 |

---

## 1. 共通の準備（最初の 1 回だけ）

1. **Node.js**: [https://nodejs.org/](https://nodejs.org/) から LTS 版（v22.12 以上）
2. **Phantom**: [https://phantom.com/download](https://phantom.com/download) から拡張機能を入れ、「設定 → 開発者設定 → **テストネットモード**」をオンにして **Solana Devnet** を選ぶ
3. **Devnet の SOL**: [https://faucet.solana.com/](https://faucet.solana.com/) で自分のアドレスに Devnet SOL をもらう

## 2. Web アプリを起動する

```bash
cd Sorana
npm install      # 最初の 1 回だけ
npm run dev
```

`http://localhost:5173/` を Phantom を入れたブラウザで開きます。

---

## 3. GPU を貸す（貸し手）

### 3-1. 必要なもの

- Python 3.10〜3.12（インストール時に「Add python.exe to PATH」にチェック）
- cloudflared（インターネット公開用）: `winget install --id Cloudflare.cloudflared -e`
- GPU の最新ドライバ

### 3-2. エージェントの準備（最初の 1 回だけ）

```powershell
cd Sorana\agent
.\setup.bat intel     # Intel Arc / Core Ultra 内蔵 GPU（例: Arc 140T）
# .\setup.bat nvidia  # NVIDIA GPU
# .\setup.bat cpu     # GPU なし
```

### 3-3. 起動して出品

```powershell
.\start.bat
```

1. 初回はベンチマークが走り、価格が決まります（やり直すには `start.bat --rebench`）
2. ブラウザで出品ページが自動で開きます。Phantom を接続して「このウォレットで出品する」→ 承認
   - 出品の保証金 約 0.003 SOL（取り下げると戻る）と、エージェントの手数料用 0.01 SOL を支払います
3. 「GPU を借りる」タブに表示されれば完了。**次回からは `start.bat` を起動するだけ** で、エージェントが自動で新しい URL を書き込み受付を再開します
4. 停止は `Ctrl + C`（自動で「受付停止」が記録されます）
5. 「GPU を貸す」タブの「あなたの出品」から、取り下げ・精算ができます

> エージェントの鍵は `agent/data/operator.json` に保存されます。消すと出品を作り直す必要があります。

### ⚠️ 安全について

借りた人は Jupyter を通して **あなたの PC 上で自由にプログラムを実行できます**。専用フォルダ（`agent/sessions/`）で起動しターミナル機能は無効にしていますが、**完全な隔離ではありません**。大事なデータの無い PC で、デモの間だけ起動してください。自分の PC 内だけで試すときは `start.bat --no-tunnel`。

---

## 4. GPU を借りる（借り手）

1. 「GPU を借りる」タブで GPU を選び、レンタル時間（分）を入力
2. 「レンタルする（エスクローに預ける）」→ Phantom で承認
3. 「マイレンタル」タブで貸し手の準備を待つ（10〜30 秒）→ **「Jupyter を開く」**
4. Jupyter で GPU を使う（例: Intel Arc なら `device="xpu"`、NVIDIA なら `"cuda"`）
   ```python
   import torch
   x = torch.randn(4096, 4096, device="xpu")
   print((x @ x).sum())
   ```
5. 時間になると環境は停止し、代金は自動で貸し手に支払われます

**返金**: 開始前なら「キャンセルして返金」。貸し手が 5 分以内に開始しなかった場合は「返金を受ける」で全額戻ります。

---

## 5. プログラムのビルド・テスト・デプロイ（開発者向け）

WSL (Ubuntu) に Rust・Solana CLI・Anchor 1.2.2 を入れて実行します。

```bash
# WSL で
bash program/build.sh          # ビルド + テスト（LiteSVM。時計を進めて期限切れもテスト）
bash program/build.sh deploy   # + Devnet へデプロイ（デプロイ用ウォレットに約 2.2 SOL 必要）
```

- **SBPF v0 でビルドしています**: Anchor 1.2.2 の既定は SBPF v3 ですが、Devnet ではまだ v3 が有効になっていないため（2026 年 11 月時点）
- プログラムのアドレス用の鍵とデプロイ用ウォレットは `program/.keys/`（git には含めません）
- ローカル validator での通しテスト:
  ```bash
  # WSL で
  solana-test-validator --reset --bpf-program <PROGRAM_ID> ~/sorana-build/target/deploy/sorana_market.so
  # Windows で
  node scripts/e2e-local.ts
  ```
  Web アプリをローカル validator につなぐには `.env.local` に `VITE_RPC_URL=http://127.0.0.1:8899`

---

## 画面とスライドのデザイン

画面は Meta 系のデザインシステム **Astryx**（`@astryxdesign/core`）の部品とテーマで組んでいます。自前の CSS はありません。

- 部品の使い方: `npx astryx component <名前>`、全体のルール: `AGENTS.md`
- テーマの変更: `npx astryx theme list` → `npx astryx theme add <名前>` → `npx astryx theme use <名前>`
- 発表スライド: `npm run dev` で `http://localhost:5173/slides.html`。直したら `npm run slides:export` で `Sorana発表資料/` に PDF と pptx（スピーカーノート付き）を書き出し（Microsoft Edge が必要）

## 6. その他: 直接送金

「直接送金」タブでは、送金先アドレスと数量（SOL）を自由に指定して送金できます。

## 7. よくあるエラー

| 表示 | 原因と対処 |
| --- | --- |
| ウォレットで承認がキャンセルされました | Phantom で「キャンセル」を押した |
| 残高が足りません | Faucet で Devnet SOL を入手 |
| RPC が混雑しています | 公開 Devnet RPC の制限。少し待って再試行 |
| この GPU は使用中か、他の人が開始待ちです | 他の人が利用中 |
| 価格が変わりました | 一覧を更新してから再実行 |
| 開始期限を過ぎています | 「マイレンタル」から返金を受ける |
| 未精算のレンタルがあるため取り下げられません | 精算・返金が終わってから取り下げ |
| この出品リンクは古いか… | エージェントに表示された最新のリンクを開く |
| `cloudflared が見つかりません` | `winget install --id Cloudflare.cloudflared -e` を実行し PowerShell を開き直す |

---

## 8. GitHub Pages で公開する

`.github/workflows/deploy.yml` により、**main ブランチに push すると自動でビルドして公開** されます（公開されるのは Web アプリだけ）。

1. リポジトリの **Settings → Pages** で Source を **GitHub Actions** にする
2. **Actions** タブで「Deploy to GitHub Pages」が緑になるのを待つ
3. 公開 URL: `https://<ユーザー名>.github.io/<リポジトリ名>/`
4. 貸し手は `start.bat --site https://<ユーザー名>.github.io/<リポジトリ名>/` で起動すると、出品リンクが公開版を指します

> private リポジトリで Pages を使うには GitHub の有料プランが必要です。

---

## 費用の目安

| 項目 | Devnet | Mainnet の目安 |
| --- | --- | --- |
| プログラムのデプロイ | Faucet の SOL で無料 | 約 1.1 SOL（保証金。プログラムを閉じれば戻る） |
| 出品 1 件 | 無料 | 約 0.003 SOL（保証金。取り下げで戻る） |
| レンタル 1 件 | 無料 | 約 0.002 SOL（保証金。終了時に借り手へ戻る）+ 代金 |
| 取引手数料 | 無料 | 1 回 約 0.000005 SOL |
