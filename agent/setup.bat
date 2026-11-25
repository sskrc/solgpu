@echo off
REM Amari エージェントの準備（最初の 1 回だけ）
REM 使い方:  setup.bat intel   … Intel Arc / Core Ultra 内蔵 GPU
REM          setup.bat nvidia  … NVIDIA GeForce / RTX など
REM          setup.bat cpu     … GPU なし（CPU で動作確認）
chcp 65001 > nul
cd /d "%~dp0"
set KIND=%1
if "%KIND%"=="" set KIND=intel
if "%KIND%"=="intel"  set INDEX=https://download.pytorch.org/whl/xpu
if "%KIND%"=="nvidia" set INDEX=https://download.pytorch.org/whl/cu128
if "%KIND%"=="cpu"    set INDEX=https://download.pytorch.org/whl/cpu
if not exist .venv python -m venv .venv || goto :error
.venv\Scripts\python -m pip install --upgrade pip || goto :error
echo PyTorch (%KIND%) をインストールしています… 数 GB あるので時間がかかります
.venv\Scripts\python -m pip install torch --index-url %INDEX% || goto :error
.venv\Scripts\python -m pip install -r requirements.txt || goto :error
echo.
echo 準備完了！ start.bat で起動できます。
goto :eof
:error
echo エラーが発生しました。上のメッセージを確認してください。
exit /b 1
