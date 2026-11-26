#!/usr/bin/env bash
# SolGPU エージェントの準備 (Linux / macOS)
# 使い方: ./setup.sh nvidia | intel | cpu   (macOS は cpu を指定すると Apple GPU も使えます)
set -e
cd "$(dirname "$0")"
case "${1:-nvidia}" in
  nvidia)
    INDEX=https://download.pytorch.org/whl/cu128
    # cu128 版は CC 7.5 未満 (V100 / P100 / GTX10 系など) に非対応 → cu126 を使う
    CC=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | sort -V | head -1)
    if [ -n "$CC" ] && [ "$(printf '%s\n7.5\n' "$CC" | sort -V | head -1)" != "7.5" ]; then
      echo "古い GPU (CC $CC) を検出: cu126 版 PyTorch を使います"
      INDEX=https://download.pytorch.org/whl/cu126
    fi ;;
  intel)  INDEX=https://download.pytorch.org/whl/xpu ;;
  *)      INDEX=https://download.pytorch.org/whl/cpu ;;
esac
[ -d .venv ] || python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install torch --index-url "$INDEX"
.venv/bin/python -m pip install -r requirements.txt
# cloudflared（インターネット公開用）が無ければ入れる
install_cloudflared_apt() {
  command -v apt-get >/dev/null || return 1
  sudo mkdir -p --mode=0755 /usr/share/keyrings &&
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null &&
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' |
    sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null &&
  sudo apt-get update && sudo apt-get install -y cloudflared
}
install_cloudflared_binary() {
  case "$(uname -m)" in
    x86_64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) return 1 ;;
  esac
  mkdir -p "$HOME/.local/bin" &&
  curl -fL -o "$HOME/.local/bin/cloudflared" \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH" &&
  chmod +x "$HOME/.local/bin/cloudflared"
}
if command -v cloudflared >/dev/null || [ -x "$HOME/.local/bin/cloudflared" ]; then
  echo "cloudflared: インストール済み"
elif [ "$(uname)" = Darwin ]; then
  if command -v brew >/dev/null; then brew install cloudflared
  else echo "cloudflared が必要です: brew install cloudflared を実行してください"; fi
else
  echo "cloudflared をインストールします（sudo のパスワードを聞かれることがあります）"
  if ! install_cloudflared_apt; then
    echo "apt で入れられなかったので ~/.local/bin に直接ダウンロードします"
    install_cloudflared_binary || echo "cloudflared を自動で入れられませんでした。README の手順で入れてください"
  fi
fi

echo "準備完了！  .venv/bin/python solgpu_agent.py --i-understand-the-risk で起動できます"
