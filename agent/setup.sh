#!/usr/bin/env bash
# SolGPU エージェントの準備 (Linux / macOS)
# 使い方: ./setup.sh nvidia | intel | cpu   (macOS は cpu を指定すると Apple GPU も使えます)
set -e
cd "$(dirname "$0")"
case "${1:-nvidia}" in
  nvidia) INDEX=https://download.pytorch.org/whl/cu128 ;;
  intel)  INDEX=https://download.pytorch.org/whl/xpu ;;
  *)      INDEX=https://download.pytorch.org/whl/cpu ;;
esac
[ -d .venv ] || python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install torch --index-url "$INDEX"
.venv/bin/python -m pip install -r requirements.txt
echo "準備完了！  .venv/bin/python sorana_agent.py --i-understand-the-risk で起動できます"
