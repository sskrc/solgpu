#!/usr/bin/env bash
# StreamDiffusion 専用の Jupyter カーネルを準備する (Linux / macOS, NVIDIA GPU 向け)
# 先に ../setup.sh を実行してから使います。  使い方: ./setup.sh
set -e
cd "$(dirname "$0")"
AGENT="$(cd .. && pwd)"
[ -x "$AGENT/.venv/bin/python" ] || { echo "先に agent/setup.sh を実行してください"; exit 1; }
command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"

# diffusers 0.24 が動く Python 3.11 の専用環境
[ -d .venv ] || uv venv --python 3.11 .venv
INDEX=https://download.pytorch.org/whl/cu128
CC=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | sort -V | head -1)
if [ -n "$CC" ] && [ "$(printf '%s\n7.5\n' "$CC" | sort -V | head -1)" != "7.5" ]; then
  INDEX=https://download.pytorch.org/whl/cu126  # V100 / GTX10 系など
fi
uv pip install --python .venv/bin/python torch torchvision --index-url "$INDEX"
uv pip install --python .venv/bin/python -r requirements.txt

# エージェントの Jupyter から見えるよう、エージェントの .venv にカーネルを登録
.venv/bin/python -m ipykernel install --prefix "$AGENT/.venv" --name streamdiffusion --display-name "StreamDiffusion (GPU)"
# エージェント側の JupyterLab にもウィジェット表示用の拡張を入れる
"$AGENT/.venv/bin/python" -m pip install "ipywidgets>=8"

# モデルを先にダウンロードしておく（デモ中に待たないように）
.venv/bin/python sd_demo.py --download
echo "準備完了！ エージェントを起動すると、借り手の Jupyter に StreamDiffusion のノートブックが表示されます"
