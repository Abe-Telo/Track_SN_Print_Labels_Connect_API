@echo off
REM Same as Scripts\StartPrintAgentHidden.bat - lives next to the print kit.
REM Silent/hidden start for Startup / logon.

if /I not "%~1"=="__hidden__" (
  powershell -NoProfile -WindowStyle Hidden -Command ^
    "Start-Process -FilePath '%~f0' -ArgumentList '__hidden__' -WindowStyle Hidden"
  exit /b 0
)

setlocal
cd /d "%~dp0"
if not exist "token.txt" exit /b 1
if not exist "config.json" (
  if exist "config.example.json" copy /y "config.example.json" "config.json" >nul
)

powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0cache_sumatra_local.ps1"
powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0print_agent.ps1"
exit /b %ERRORLEVEL%
