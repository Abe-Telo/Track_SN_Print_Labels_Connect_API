# Stop OrderAssist print agent processes on this PC.
$ErrorActionPreference = 'SilentlyContinue'

$patterns = @(
  'print_agent\.ps1',
  'OrderAssistPrint\\print_agent',
  'StartPrintAgentHidden',
  'start_agent_hidden\.bat',
  'stop_background_services'
)

function Test-Match([string]$cmd) {
  if (-not $cmd) { return $false }
  foreach ($p in $patterns) {
    if ($cmd -match $p) { return $true }
  }
  return $false
}

Write-Host 'Stopping OrderAssist print background processes...'
$procs = @(Get-CimInstance Win32_Process | Where-Object { Test-Match $_.CommandLine })
# Do not kill this stop script itself
$myPid = $PID
$procs = @($procs | Where-Object { $_.ProcessId -ne $myPid })

if (-not $procs.Count) {
  Write-Host 'No matching OrderAssist print agent processes found.'
} else {
  foreach ($p in $procs) {
    $clip = if ($p.CommandLine.Length -gt 140) { $p.CommandLine.Substring(0, 140) + '...' } else { $p.CommandLine }
    Write-Host ("Stopping PID {0}: {1}" -f $p.ProcessId, $clip)
    Stop-Process -Id $p.ProcessId -Force
  }
}

Start-Sleep -Seconds 1

$left = @(Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne $myPid -and (Test-Match $_.CommandLine) -and ($_.CommandLine -notmatch 'stop_background_services')
})
if ($left.Count) {
  Write-Host 'WARNING: still running:'
  $left | ForEach-Object { Write-Host ("  PID {0}" -f $_.ProcessId) }
} else {
  Write-Host 'All OrderAssist print agent processes stopped.'
}

$suma = @(Get-Process -Name 'SumatraPDF' -ErrorAction SilentlyContinue)
if ($suma.Count) {
  Write-Host ("Stopping {0} SumatraPDF process(es)..." -f $suma.Count)
  $suma | Stop-Process -Force
} else {
  Write-Host 'No SumatraPDF.exe processes.'
}

Write-Host ''
Write-Host 'Hidden agents will not resume until you run start_agent.bat or start_agent_hidden.bat again.'
