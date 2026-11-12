@echo off
chcp 65001 >nul
title 知时智农 · 农事决策助手
cd /d "%~dp0web"

echo ============================================
echo   知时智农 · 华北平原农事决策助手
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [提示] 未检测到 Node.js
  echo.
  echo 不用担心，你可以直接双击 web\index.html 打开，
  echo 所有核心功能在浏览器里都能正常使用，包括图表和问答。
  echo.
  echo 只有这两项需要 Node.js：
  echo   · 「用我的位置」定位（浏览器安全限制）
  echo   · 手机扫码访问
  echo.
  echo 如需完整功能，安装 Node.js 后重新运行本文件：https://nodejs.org/
  echo （选 LTS 版本，一路下一步即可）
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node --version') do echo [OK] Node.js %%v

set PORT=8931

netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul 2>nul
if not errorlevel 1 (
  echo [提示] 端口 %PORT% 被占用，自动改用 8932
  set PORT=8932
)

echo [OK] 正在启动服务...
echo.
echo   本机打开：http://127.0.0.1:%PORT%/
echo   手机扫码：见下方二维码（手机需连同一个 WiFi）
echo.

start "" "http://127.0.0.1:%PORT%/"
start "" "http://127.0.0.1:%PORT%/qr"

rem --lan 让手机能通过局域网访问；不带该参数则仅限本机
node server.mjs %PORT% --lan

echo.
echo 服务已停止。
pause
