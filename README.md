# Sorana — みんなの GPU を SOL で貸し借り（Solana Devnet デモ）

AI 需要で GPU が足りない一方、個人の PC の GPU は多くの時間あまっています。
Sorana は **誰でも自分の GPU を出品でき、誰でも分単位で借りられる** GPU マーケットプレイスです。支払いは Solana で、借り手から貸し手へ直接送られます。

- 貸し手: エージェントを起動 → **ベンチマークで性能を測定し価格を自動決定** → Phantom で出品
- 借り手: 一覧から GPU を選ぶ → 分数を指定 → Phantom で支払い → **ブラウザの Jupyter Lab でその GPU が使える**
- 時間になると環境は自動停止

> ⚠️ **Devnet（テスト用ネットワーク）専用** です。本物の SOL は動きません。

---

## 仕組み

```
 貸し手の PC                                Solana Devnet                    借り手のブラウザ
┌────────────────────┐                ┌──────────────────┐          ┌──────────────────────┐
│ Sorana エージェント │ ── 出品メモ ──▶ │  出品一覧（メモ） │ ◀─ 読む ─ │ Sorana Web アプリ     │
│  ・ベンチマーク      │  (Phantomで署名) │                  │          │ (GitHub Pages)       │
│  ・支払いの確認      │ ◀─ 支払いを読む ─│  借り手→貸し手    │ ◀─ 送金 ─ │  Phantom で支払い     │
│  ・Jupyter 起動/停止 │                └──────────────────┘          │                      │
│                    │ ◀──────── 予約 / 利用開始 (HTTPS, Cloudflare Tunnel) ────────│                      │
│  Jupyter Lab + GPU │ ◀──────────────── ブラウザで GPU を使う ───────────────────│                      │
└────────────────────┘                                                └──────────────────────┘
```

1. **出品**: エージェントが起動時に GPU の性能を測り、価格を決め、Cloudflare Tunnel で `https://xxxx.trycloudflare.com` の URL を作ります。貸し手は表示されたリンクを開き、Phantom で「出品トランザクション」（目印アドレスへの 0 SOL 送金 + メモ）に署名します。出品一覧は **Solana 上のメモ** として保存されるので、中央のサーバーやデータベースはありません。
2. **予約**: 借り手が GPU を選ぶと、まずエージェントに予約します（2 人が同時に支払うのを防ぐため。5 分間有効）。
3. **支払い**: 借り手は貸し手のウォレットに直接 `分数 × 1分あたりの価格` を送金します。メモには予約 ID・分数・**借り手だけが知る秘密の値のハッシュ** が入ります。
4. **利用開始**: 借り手のブラウザが署名と秘密の値をエージェントに送ります。エージェントは Devnet 上の取引を読み、金額・受取先・メモ・秘密の値を確認してから、専用フォルダで Jupyter Lab を起動し、URL を借り手にだけ返します。
5. **終了**: 利用時間（Jupyter が使えるようになった時点から数える）が過ぎると、エージェントが Jupyter とその中のプログラムをすべて停止します。

### 価格の決め方

エージェントが PyTorch で行列積（GPU は fp16、CPU は fp32）を実行し、性能を TFLOPS で測ります。

```
1 分あたりの価格 = 計測 TFLOPS × 0.000002 SOL（最低 0.00001 SOL / 分）
```

例: 20 TFLOPS の GPU → 0.00004 SOL / 分（1 時間 0.0024 SOL）

### 正直に書いておくこと（デモの制約）

- **エスクローはありません**: 支払いは直接貸し手へ。貸し手が GPU を提供しなくても返金されません。
- **ベンチマークは自己申告**: エージェントが測った値をそのまま使います（改ざんは可能）。
- **Cloudflare Tunnel** という中央のサービスを経由しています。
- 借りた記録（秘密の値）はブラウザに保存されます。ブラウザのデータを消すと、そのレンタルは使えなくなります。
- 貸し手がエージェントを止めると、利用中・支払い済みのレンタルも終了します。
- 利用時間が終わると、借り手が Jupyter に保存したファイルは削除されます。

→ 今後の発展: Anchor プログラムでのエスクロー・オンチェーンでのベンチマーク検証・評判システムなど。

---

## ファイル構成

| パス | 内容 |
| --- | --- |
| `src/App.tsx` | 画面全体（タブ切り替え・ウォレット表示） |
| `src/pages/Market.tsx` | GPU を借りる（一覧・予約・支払い） |
| `src/pages/MyRentals.tsx` | マイレンタル（Jupyter を開く・残り時間・再試行） |
| `src/pages/Lend.tsx` | GPU を貸す（出品） |
| `src/pages/Transfer.tsx` | 直接送金（アドレスと数量を指定して SOL を送る） |
| `src/lib/solana.ts` | Solana との通信、署名と送信、エラーの日本語化 |
| `src/lib/market.ts` | 出品一覧の読み込み、エージェントとの通信 |
| `agent/sorana_agent.py` | 貸し手エージェント（ベンチマーク・支払い確認・Jupyter 管理） |
| `agent/setup.bat`, `agent/start.bat` | エージェントの準備と起動（Windows） |
| `.github/workflows/deploy.yml` | GitHub Pages への自動公開 |

---

## 1. 共通の準備（最初の 1 回だけ）

### 1-1. Node.js

[https://nodejs.org/](https://nodejs.org/) から **LTS 版**（v22.12 以上）をインストールします。

### 1-2. Phantom ウォレット

1. [https://phantom.com/download](https://phantom.com/download) からブラウザ拡張機能を入れ、ウォレットを作成
2. Phantom の「設定 → 開発者設定 → **テストネットモード**」をオンにし、**Solana Devnet** を選ぶ

### 1-3. Devnet の SOL を入手

[https://faucet.solana.com/](https://faucet.solana.com/) で自分のアドレスを貼り付け、**Devnet** を選んでリクエストします。
（`solana airdrop` などの RPC 経由のエアドロップは現在 Devnet で停止されています）

---

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

- Python 3.10〜3.12（[python.org](https://www.python.org/downloads/)。インストール時に「Add python.exe to PATH」にチェック）
- cloudflared（インターネット公開用）: PowerShell で
  ```powershell
  winget install --id Cloudflare.cloudflared -e
  ```
- GPU のドライバ（Intel Arc / NVIDIA は最新のドライバを推奨）

### 3-2. エージェントの準備（最初の 1 回だけ）

PowerShell で `agent` フォルダに移動し、GPU の種類に合わせて実行します。PyTorch（数 GB）をダウンロードするので時間がかかります。

```powershell
cd Sorana\agent
.\setup.bat intel     # Intel Arc / Core Ultra 内蔵 GPU（例: Arc 140T）
# .\setup.bat nvidia  # NVIDIA GPU
# .\setup.bat cpu     # GPU なし
```

Linux / macOS は `./setup.sh nvidia` などを使います。

### 3-3. 起動して出品

```powershell
.\start.bat
```

1. 初回はベンチマークが走り、価格が表示されます（結果は保存され、次回からは省略。やり直すには `start.bat --rebench`）
2. `https://xxxx.trycloudflare.com` の URL と **出品リンク** が表示されます
3. 出品リンクを Phantom を入れたブラウザで開き、「このウォレットで出品する」→ Phantom で承認
4. 「GPU を借りる」タブに自分の GPU が表示されれば出品完了です。**エージェントを動かしている間だけ** 貸し出されます
5. 停止するときは、エージェントの画面で `Ctrl + C`

> エージェントを起動し直すと URL が変わるので、毎回 3 の出品をやり直してください。出品リンクは 1 回だけ使えます。

> Web アプリを GitHub Pages で公開している場合は、出品リンクの宛先をそちらにします:
> `start.bat --site https://<ユーザー名>.github.io/<リポジトリ名>/`

### ⚠️ 安全について（必ず読んでください）

借りた人は Jupyter を通して **あなたの PC 上で自由にプログラムを実行できます**。エージェントは専用フォルダ（`agent/sessions/`）で Jupyter を起動し、ターミナル機能を無効にしていますが、**完全な隔離ではありません**（Python から PC 内のファイルやネットワークにアクセスできます）。

- 大事なデータの無い PC で使う
- デモの間だけ起動し、終わったら `Ctrl + C` で止める
- 自分の PC 内だけで試すときは `start.bat --no-tunnel`（インターネットに公開しない）

本格的に運用するには、Docker や仮想マシンによる隔離が必要です。

---

## 4. GPU を借りる（借り手）

1. 「GPU を借りる」タブで、オンラインの GPU から 1 つ選ぶ（性能と 1 分あたりの価格が表示されます）
2. レンタル時間（分）を入力 → 「レンタルする」→ Phantom で承認
3. 自動で「マイレンタル」タブに移動し、環境の準備ができると **「Jupyter を開く」** ボタンが出ます（10〜30 秒）
4. Jupyter で GPU を使います。例（Intel Arc の場合）:
   ```python
   import torch
   x = torch.randn(4096, 4096, device="xpu")   # NVIDIA なら "cuda"
   print((x @ x).sum())
   ```
5. 残り時間が 0 になると環境は自動で停止します。必要なファイルは事前にダウンロードしてください

支払い後に利用開始できなかった場合（通信エラー・GPU が別のレンタルで使用中など）は、「マイレンタル」から **「利用開始を再試行」** できます。
ただし **貸し手がエージェントを再起動・停止した場合、そのレンタルは再開できません**（URL と予約情報が変わるため。デモでは返金もありません）。

---

## 5. その他の機能: 直接送金

「直接送金」タブでは、送金先アドレスと数量（SOL）を自由に指定して送金できます。

---

## 6. よくあるエラー

| 表示 | 原因と対処 |
| --- | --- |
| ウォレットで承認がキャンセルされました | Phantom で「キャンセル」を押した。もう一度実行 |
| 残高が足りません | Faucet で Devnet SOL を入手 |
| RPC が混雑しています | 公開 Devnet RPC の制限。少し待って再試行 |
| オンラインの GPU はまだありません | 誰もエージェントを起動していない。自分で出品して試せます |
| このGPUは現在使用中か、他の人が予約中です | 他の人が利用中。終わるまで待つ |
| 貸し手のエージェントに接続できません | 貸し手がエージェントを止めた。エージェントが再起動された場合、そのレンタルは再開できません（返金なし） |
| 送信済みですが、完了を確認できませんでした | 送金は成功している可能性あり。再実行の前に Explorer で確認 |
| `PyTorch が見つかりません` | `setup.bat` を実行していない |
| `cloudflared が見つかりません` | 3-1 の winget コマンドを実行し、PowerShell を開き直す |

---

## 7. GitHub Pages で公開する

`.github/workflows/deploy.yml` により、**main ブランチに push すると自動でビルドして公開** されます。
（公開されるのは Web アプリだけです。エージェントは各貸し手の PC で動かします）

### 7-1. リポジトリを作って push

1. [https://github.com/new](https://github.com/new) でリポジトリを作成（Public、初期ファイルなし）
2. このフォルダで:
   ```bash
   git init
   git add .
   git commit -m "first commit"
   git branch -M main
   git remote add origin https://github.com/<ユーザー名>/<リポジトリ名>.git
   git push -u origin main
   ```
   初めての場合は先に `git config --global user.name "名前"` と `git config --global user.email "メール"` を設定します。

### 7-2. Pages を有効にする

1. リポジトリの **Settings → Pages** で、Source を **GitHub Actions** にする
2. **Actions** タブで「Deploy to GitHub Pages」が緑になるまで待つ（失敗していたら「Re-run all jobs」）
3. 公開 URL: `https://<ユーザー名>.github.io/<リポジトリ名>/`

以降は `git add . && git commit -m "変更内容" && git push` で自動更新されます。
`vite.config.ts` で `base: './'` にしているので、リポジトリ名に関係なく動きます。

---

## 注意

- Devnet は予告なくリセットされることがあります
- 公開 RPC（`api.devnet.solana.com`）にはリクエスト制限があります。利用者が増えたら Helius などの RPC サービスを検討してください
- 出品一覧は最新 40 件の出品トランザクションから作られます
