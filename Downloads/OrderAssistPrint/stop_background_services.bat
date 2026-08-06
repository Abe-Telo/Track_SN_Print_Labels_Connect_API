@echo off
setlocal
cd /d "%~dp0"
title OrderAssist - Stop background services
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop_background_services.ps1"
echo.
pause
