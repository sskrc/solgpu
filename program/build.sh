#!/usr/bin/env bash
# Sorana プログラムのビルドとテスト（WSL / Linux で実行）
#   bash build.sh          … ビルド + テスト
#   bash build.sh deploy   … ビルド + テスト + Devnet へデプロイ
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.avm/bin:$PATH"
SRC="$(cd "$(dirname "$0")" && pwd)"
BUILD="$HOME/sorana-build"   # Windows のフォルダ上だとビルドが遅く不安定なので、WSL 側でビルドする

mkdir -p "$BUILD/target/deploy"
rsync -a --delete --exclude target --exclude .keys --exclude node_modules "$SRC/" "$BUILD/"
# プログラムのアドレス用の鍵（無ければバックアップから復元）
[ -f "$BUILD/target/deploy/sorana_market-keypair.json" ] || cp "$SRC/.keys/sorana_market-keypair.json" "$BUILD/target/deploy/"

cd "$BUILD"
# Devnet ではまだ SBPF v3 が有効になっていないため、どのクラスタでも動く v0 でビルドする
anchor build --arch v0
cargo test 2>&1 | grep -vE "^s*(Compiling|Downloaded|Downloading)" | tail -n 40

mkdir -p "$SRC/../src/idl"
cp target/idl/sorana_market.json "$SRC/../src/idl/sorana_market.json"
cp target/idl/sorana_market.json "$SRC/../agent/sorana_market.json"
echo "プログラムのサイズ: $(stat -c %s target/deploy/sorana_market.so) bytes"

if [ "${1:-}" = "deploy" ]; then
  # テスト済みの .so をそのままデプロイする（anchor deploy は再ビルドや IDL アカウント作成をすることがあるため使わない）
  SO=target/deploy/sorana_market.so
  PID=target/deploy/sorana_market-keypair.json
  WALLET="$HOME/.config/solana/id.json"
  echo "デプロイ用ウォレット: $(solana address -k "$WALLET")  残高: $(solana balance -k "$WALLET" --url devnet)"
  # 公開 RPC は書き込み回数の制限が厳しいので、バリデーターへ直接送る既定の方式 + 多めの再試行で送る
  # （途中で失敗したら: solana program close --buffers --keypair "$WALLET" --url devnet で SOL を回収して再実行）
  solana program deploy "$SO" --program-id "$PID" --keypair "$WALLET" --url devnet --max-sign-attempts 100
  # デプロイされた中身がテスト済みのファイルと同じか確認
  solana program dump "$(solana address -k "$PID")" /tmp/sorana_dump.so --url devnet >/dev/null
  head -c "$(stat -c %s "$SO")" /tmp/sorana_dump.so | sha256sum | cut -d' ' -f1 > /tmp/a.sha
  sha256sum "$SO" | cut -d' ' -f1 > /tmp/b.sha
  if cmp -s /tmp/a.sha /tmp/b.sha; then echo "✓ デプロイされたプログラムはテスト済みのファイルと一致"; else echo "✗ 一致しません"; exit 1; fi
fi
