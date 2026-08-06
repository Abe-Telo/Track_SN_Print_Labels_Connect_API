@echo off
setlocal
cd /d "%~dp0"
title OrderAssist Print Report (test)
echo.
echo OrderAssist print report (mode C - local test)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0print_report.ps1" %*
pause
