@echo off
setlocal
cd /d "%~dp0"
title OrderAssist Print Agent
echo.
echo OrderAssist print agent (mode A)
echo Drivers stay on this PC. Frontend controls printers.
echo.
echo Stopping any previous print_agent...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -match 'print_agent\.ps1' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo Caching SumatraPDF to local disk (avoids network Run prompt)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0cache_sumatra_local.ps1"

if not exist "token.txt" (
  echo Missing token.txt
  echo Copy token.example.txt to token.txt and paste the server token.
  pause
  exit /b 1
)
if not exist "config.json" (
  copy /y "config.example.json" "config.json" >nul
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0print_agent.ps1"
echo.
echo Agent stopped.
pause
