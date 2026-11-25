@echo off
REM SolGPU エージェントを起動（インターネットに公開して貸し出す）
REM 自分の PC 内だけで試す場合:  start.bat --no-tunnel
chcp 65001 > nul
cd /d "%~dp0"
if "%1"=="--no-tunnel" (
  .venv\Scripts\python solgpu_agent.py %*
) else (
  .venv\Scripts\python solgpu_agent.py --i-understand-the-risk %*
)
pause
