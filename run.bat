@echo off
setlocal
cd /d "%~dp0"
title EZClaw

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js belum terpasang. Pasang Node.js 22.12 atau lebih baru dari https://nodejs.org lalu jalankan file ini lagi.
  pause
  exit /b 1
)
where pnpm >nul 2>nul
if errorlevel 1 (
  echo pnpm belum terpasang. Jalankan: npm install -g pnpm
  pause
  exit /b 1
)

if not exist node_modules (
  echo Memasang dependensi, cukup sekali...
  call pnpm install
  if errorlevel 1 (
    echo Gagal memasang dependensi.
    pause
    exit /b 1
  )
)

set NEED_BUILD=
if /i "%~1"=="rebuild" set NEED_BUILD=1
if not exist apps\server\dist\index.js set NEED_BUILD=1
if not exist apps\web\dist\index.html set NEED_BUILD=1
if defined NEED_BUILD (
  echo Membangun EZClaw...
  call pnpm build
  if errorlevel 1 (
    echo Build gagal.
    pause
    exit /b 1
  )
)

if not defined EZCLAW_PORT set EZCLAW_PORT=8787
echo.
echo EZClaw berjalan di http://127.0.0.1:%EZCLAW_PORT%
echo Tutup jendela ini atau tekan Ctrl+C untuk menghentikan.
echo.
start "" /min cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:%EZCLAW_PORT%"
node apps\server\dist\index.js
echo.
echo Server berhenti.
pause
