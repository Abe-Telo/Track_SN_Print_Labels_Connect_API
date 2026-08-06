@echo off
REM Installs the OrderAssist print agent into the current user's Startup folder.
REM Copies the starter locally so logon still works before H: is mapped.
REM The local starter waits for H:\Printer\OrderAssistPrint, then runs print_agent.ps1.

setlocal
set "SRC=%~dp0StartPrintAgentHidden.bat"
set "LOCAL_DIR=%LOCALAPPDATA%\OrderAssistPrint"
set "LOCAL_BAT=%LOCAL_DIR%\StartPrintAgentHidden.bat"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LNK=%STARTUP%\OrderAssistPrintAgent.lnk"

if not exist "%SRC%" (
  echo StartPrintAgentHidden.bat not found next to this script.
  echo Expected: %SRC%
  pause
  exit /b 1
)

if not exist "%LOCAL_DIR%" mkdir "%LOCAL_DIR%"
copy /y "%SRC%" "%LOCAL_BAT%" >nul
if errorlevel 1 (
  echo Failed to copy starter to %LOCAL_BAT%
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%LNK%'); $s.TargetPath = '%LOCAL_BAT%'; $s.WorkingDirectory = '%LOCAL_DIR%'; $s.WindowStyle = 7; $s.Description = 'Start OrderAssist print agent (waits for H: then runs print_agent.ps1)'; $s.Save(); Write-Host 'Startup shortcut created: %LNK%'"

echo.
echo Local starter : %LOCAL_BAT%
echo Startup link  : %LNK%
echo.
echo The print agent will start automatically after each logon
echo (after H: is available / MapHDrive has run).
echo.
pause
exit /b 0
