<#
.SYNOPSIS
  Mode A - OrderAssist office print agent.

.DESCRIPTION
  Drivers are installed on THIS Windows PC (Brother/Dymo/Zebra/HP).
  This script:
    - reports every local/WiFi printer to the Printers frontend
    - copies/exports driver packages into .\drivers\<PrinterName>\
    - maps those folders by real Windows printer name for the frontend
    - prints queued jobs the frontend creates

  Run from the office PC that shares the printer (e.g. H:\Printer\OrderAssistPrint).
  Do not run from a laptop that is not on the office network.
#>
param(
  [string]$BaseUrl,
  [string]$Token,
  [int]$PollSeconds,
  [string]$WorkDir = "$env:TEMP\OrderAssistPrintAgent"
)

$ErrorActionPreference = "Stop"
$Root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
Set-Location $Root

function Read-Config {
  $cfgPath = Join-Path $Root "config.json"
  if (-not (Test-Path $cfgPath)) { return @{} }
  try { return Get-Content $cfgPath -Raw | ConvertFrom-Json } catch { return @{} }
}

function Get-SafeFolderName([string]$Name) {
  $safe = ($Name -replace '[<>:"/\\|?*]', '_').Trim()
  if (-not $safe) { $safe = 'printer' }
  if ($safe.Length -gt 80) { $safe = $safe.Substring(0, 80) }
  return $safe
}

$cfg = Read-Config
if (-not $BaseUrl) { $BaseUrl = [string]$cfg.BaseUrl }
if (-not $BaseUrl) { $BaseUrl = "https://orderassistnow.com:3000" }
if (-not $PollSeconds) {
  if ($cfg.PollSeconds) { $PollSeconds = [int]$cfg.PollSeconds } else { $PollSeconds = 3 }
}
if (-not $Token) {
  $tokenPath = Join-Path $Root "token.txt"
  if (Test-Path $tokenPath) {
    $Token = (Get-Content $tokenPath -Raw).Trim()
  }
}
if (-not $Token -or $Token -match "PASTE_TOKEN") {
  throw "Set token.txt in $Root (copy from Printers > Agent tab)"
}

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Root "outbox") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Root "drivers") | Out-Null

$headers = @{ "X-Print-Agent-Token" = $Token }

Write-Host "OrderAssist print agent (A) v2026-08-06e"
Write-Host "Folder : $Root"
Write-Host "BaseUrl: $BaseUrl"
Write-Host "Drivers map into: $Root\drivers\<PrinterName>\"

function Export-PrinterDriverFolder {
  param([string]$PrinterName, [string]$DriverName, [string]$PortName)

  $safe = Get-SafeFolderName $PrinterName
  $dest = Join-Path $Root "drivers\$safe"
  New-Item -ItemType Directory -Force -Path $dest | Out-Null

  $info = [ordered]@{
    windowsPrinterName = $PrinterName
    driverName = $DriverName
    portName = $PortName
    folder = "drivers\$safe"
    exportedAt = (Get-Date).ToString('o')
    exportOk = $false
    exportNote = $null
  }

  # Best-effort: export matching printer-class driver package via pnputil.
  try {
    $enum = & pnputil.exe /enum-drivers 2>$null | Out-String
    $blocks = $enum -split "(?=Published Name:)"
    $oem = $null
    foreach ($block in $blocks) {
      if ($DriverName -and $block -match [regex]::Escape($DriverName)) {
        if ($block -match "Published Name:\s+(\S+\.inf)") {
          $oem = $Matches[1]
          break
        }
      }
    }
    if (-not $oem -and $DriverName) {
      foreach ($block in $blocks) {
        if ($block -match "Class Name:\s+Printer" -and $block -match [regex]::Escape(($DriverName -split ' ')[0])) {
          if ($block -match "Published Name:\s+(\S+\.inf)") {
            $oem = $Matches[1]
            break
          }
        }
      }
    }
    if ($oem) {
      $exportDir = Join-Path $dest "package"
      New-Item -ItemType Directory -Force -Path $exportDir | Out-Null
      & pnputil.exe /export-driver $oem $exportDir | Out-Null
      if ($LASTEXITCODE -eq 0) {
        $info.exportOk = $true
        $info.exportNote = "Exported $oem"
        $info.oemInf = $oem
      } else {
        $info.exportNote = "pnputil export failed for $oem (exit $LASTEXITCODE). driver-info.json still maps the installed driver."
      }
    } else {
      $info.exportNote = "Could not match an oem*.inf for '$DriverName'. Folder still stores the mapping."
    }
  } catch {
    $info.exportNote = $_.Exception.Message
  }

  ($info | ConvertTo-Json -Depth 5) | Set-Content -Path (Join-Path $dest "driver-info.json") -Encoding UTF8
  return [pscustomobject]@{
    windowsPrinterName = $PrinterName
    driverName = $DriverName
    portName = $PortName
    driverFolder = "drivers\$safe"
    driverFolderName = $safe
    driverInfoPath = "drivers\$safe\driver-info.json"
    driverExportOk = [bool]$info.exportOk
  }
}

function Get-DiscoveredPrinters {
  Get-Printer | ForEach-Object {
    $map = Export-PrinterDriverFolder -PrinterName $_.Name -DriverName $_.DriverName -PortName $_.PortName
    $hint = ''
    $blob = (@($_.Name, $_.DriverName, $_.Comment, $_.Location) -join ' ')
    if ($blob -match '(?i)zebra|zsb|zb[-_ ]') { $hint = 'zebra' }
    elseif ($blob -match '(?i)brother') { $hint = 'brother' }
    elseif ($blob -match '(?i)dymo') { $hint = 'dymo' }
    elseif ($blob -match '(?i)hp|envy|laserjet|deskjet') { $hint = 'hp' }
    [pscustomobject]@{
      name = $_.Name
      driverName = $_.DriverName
      portName = $_.PortName
      comment = [string]$_.Comment
      location = [string]$_.Location
      shared = [bool]$_.Shared
      brandHint = $hint
      driverFolder = $map.driverFolder
      driverFolderName = $map.driverFolderName
      driverInfoPath = $map.driverInfoPath
      driverExportOk = $map.driverExportOk
    }
  }
}

function Send-Discovered {
  $list = @(Get-DiscoveredPrinters)
  $body = @{ printers = $list } | ConvertTo-Json -Depth 6
  Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/print/agent/discovered" -Headers $headers -ContentType "application/json" -Body $body | Out-Null

  $maps = @($list | ForEach-Object {
    [pscustomobject]@{
      windowsPrinterName = $_.name
      driverName = $_.driverName
      driverFolder = $_.driverFolder
      driverFolderName = $_.driverFolderName
      driverInfoPath = $_.driverInfoPath
      driverExportOk = $_.driverExportOk
    }
  })
  $mapBody = @{ maps = $maps } | ConvertTo-Json -Depth 6
  try {
    Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/print/agent/driver-map" -Headers $headers -ContentType "application/json" -Body $mapBody | Out-Null
  } catch {
    Write-Warning "driver-map: $($_.Exception.Message)"
  }
  Write-Host "$(Get-Date -Format o) Reported $($list.Count) printers; driver folders under .\drivers\"
}

function Complete-Job([string]$JobId, [bool]$Ok, [string]$ErrorText) {
  $body = @{ jobId = $JobId; ok = $Ok; error = $ErrorText } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/print/agent/complete" -Headers $headers -ContentType "application/json" -Body $body | Out-Null
}

function Test-IsNetworkPath([string]$Path) {
  if (-not $Path) { return $false }
  try {
    $root = [System.IO.Path]::GetPathRoot((Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path)
  } catch {
    $root = [System.IO.Path]::GetPathRoot($Path)
  }
  if (-not $root) { return $false }
  if ($root.StartsWith('\\')) { return $true }
  $drive = Get-PSDrive -Name $root.TrimEnd('\').TrimEnd(':') -ErrorAction SilentlyContinue
  if ($drive -and $drive.DisplayRoot -and ($drive.DisplayRoot -match '^\\\\|^https?://')) { return $true }
  # Mapped network / WebDAV (H: keys share, etc.)
  try {
    $net = Get-CimInstance -ClassName Win32_MappedLogicalDisk -ErrorAction SilentlyContinue |
      Where-Object { $_.DeviceID -eq ($root.TrimEnd('\')) }
    if ($net) { return $true }
  } catch {}
  return $false
}

function Unblock-TrustedLocalFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  try { Unblock-File -LiteralPath $Path -ErrorAction SilentlyContinue } catch {}
  try { Remove-Item -LiteralPath ($Path + ':Zone.Identifier') -Force -ErrorAction SilentlyContinue } catch {}
}

function Get-LocalSumatraDir {
  $dir = Join-Path $env:LOCALAPPDATA 'OrderAssistPrint'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  return $dir
}

function Get-SumatraExe {
  # Always prefer a LOCAL copy. Running Sumatra from H: (network/WebDAV) triggers
  # Windows "Open File - Security Warning" on every print.
  $trustedDir = Get-LocalSumatraDir
  $trusted = Join-Path $trustedDir 'SumatraPDF.exe'
  $kitLocal = Join-Path $Root 'SumatraPDF.exe'

  function Use-IfGood([string]$exe) {
    if ($exe -and (Test-Path -LiteralPath $exe) -and ((Get-Item -LiteralPath $exe).Length -gt 1000000)) {
      if (-not (Test-IsNetworkPath $exe)) {
        Unblock-TrustedLocalFile $exe
        return $exe
      }
    }
    return $null
  }

  $hit = Use-IfGood $trusted
  if ($hit) { return $hit }

  foreach ($exe in @(
      "$env:LOCALAPPDATA\SumatraPDF\SumatraPDF.exe",
      "$env:ProgramFiles\SumatraPDF\SumatraPDF.exe",
      "${env:ProgramFiles(x86)}\SumatraPDF\SumatraPDF.exe"
    )) {
    $hit = Use-IfGood $exe
    if ($hit) { return $hit }
  }

  # Copy from kit (even if kit is on H:) into local trusted folder once
  $source = $null
  foreach ($cand in @($kitLocal, (Join-Path $Root 'SumatraPDF\SumatraPDF.exe'))) {
    if ($cand -and (Test-Path -LiteralPath $cand) -and ((Get-Item -LiteralPath $cand).Length -gt 1000000)) {
      $source = $cand
      break
    }
  }

  if (-not $source) {
    try {
      $url = "$BaseUrl/Downloads/OrderAssistPrint/SumatraPDF.exe"
      Write-Host "  downloading SumatraPDF from $url -> $trusted"
      Invoke-WebRequest -Uri $url -OutFile $trusted -UseBasicParsing
      Unblock-TrustedLocalFile $trusted
      $hit = Use-IfGood $trusted
      if ($hit) { return $hit }
    } catch {
      Write-Warning "Could not download SumatraPDF: $($_.Exception.Message)"
    }
    return $null
  }

  try {
    Write-Host "  caching SumatraPDF locally (avoids network Run prompt):"
    Write-Host "    from: $source"
    Write-Host "    to  : $trusted"
    Copy-Item -LiteralPath $source -Destination $trusted -Force
    Unblock-TrustedLocalFile $trusted
    $hit = Use-IfGood $trusted
    if ($hit) { return $hit }
  } catch {
    Write-Warning "Could not cache SumatraPDF locally: $($_.Exception.Message)"
  }

  # Last resort: kit path (may prompt every time if on H:)
  if ($source) {
    Write-Warning "Using network SumatraPDF path - Windows may prompt Run each time: $source"
    return $source
  }
  return $null
}

function Get-PrinterProblem([string]$PrinterName) {
  $pr = Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue
  if (-not $pr) { return "Windows printer not found: '$PrinterName'" }
  $status = [string]$pr.PrinterStatus
  if ($pr.WorkOffline) { return "Printer '$PrinterName' is WorkOffline" }
  if ($status -match '(?i)PaperOut|OutOfPaper|NoPaper') {
    return "Printer '$PrinterName' is Out of Paper (status=$status)"
  }
  if ($status -match '(?i)Offline') {
    return "Printer '$PrinterName' is Offline (status=$status)"
  }
  if ($status -match '(?i)Error|DoorOpen|Toner|UserIntervention|PaperJam') {
    return "Printer '$PrinterName' needs attention (status=$status)"
  }
  # Spooler queue title / job errors often say Out of Paper even when PrinterStatus still Normal
  try {
    $badJobs = @(Get-PrintJob -PrinterName $PrinterName -ErrorAction SilentlyContinue |
      Where-Object { [string]$_.JobStatus -match '(?i)PaperOut|Error|Offline|UserIntervention' })
    if ($badJobs.Count) {
      $js = ($badJobs | ForEach-Object { $_.JobStatus }) -join ','
      return "Printer '$PrinterName' has stuck spool job(s): $js"
    }
  } catch {}
  return $null
}

function Ensure-PrinterReady {
  param([Parameter(Mandatory = $true)][string]$PrinterName)
  $pr = Get-Printer -Name $PrinterName -ErrorAction Stop
  try {
    if ($pr.WorkOffline) {
      Write-Host "  clearing WorkOffline on '$PrinterName'"
      Set-Printer -Name $PrinterName -WorkOffline $false -ErrorAction SilentlyContinue
    }
  } catch {}
  try {
    Get-PrintJob -PrinterName $PrinterName -ErrorAction SilentlyContinue |
      Where-Object { $_.JobStatus -match 'Error|Paused|PaperOut' } |
      ForEach-Object {
        Write-Host "  removing stuck spool job $($_.Id) status=$($_.JobStatus)"
        Remove-PrintJob -PrinterName $PrinterName -ID $_.Id -ErrorAction SilentlyContinue
      }
  } catch {}
  $pr2 = Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue
  if ($pr2) {
    Write-Host "  printer status=$($pr2.PrinterStatus) port=$($pr2.PortName) offline=$($pr2.WorkOffline)"
  }
  $problem = Get-PrinterProblem -PrinterName $PrinterName
  if ($problem -match '(?i)Out of Paper|Offline|WorkOffline|needs attention') {
    throw $problem
  }
}

function Confirm-SpoolAccepted {
  param([string]$PrinterName, [string]$PdfPath)
  Start-Sleep -Seconds 2
  $problem = Get-PrinterProblem -PrinterName $PrinterName
  if ($problem) {
    throw "Job reached Windows spooler but printer blocked it: $problem. Load paper / clear the printer error, then retry."
  }
  $pr = Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue
  if ($pr) {
    Write-Host "  post-print printer status=$($pr.PrinterStatus)"
  }
}

function Invoke-SumatraPrint {
  param(
    [string]$Sumatra,
    [string]$PdfPath,
    [string]$PrinterName,
    [string]$PrintSettings,
    [int]$TimeoutMs = 45000
  )
  $args = @('-print-to', $PrinterName, '-silent', '-exit-on-print')
  if ($PrintSettings) {
    $args += @('-print-settings', $PrintSettings)
  }
  $args += $PdfPath
  Write-Host "  Sumatra args: $($args -join ' ')"
  $p = Start-Process -FilePath $Sumatra -ArgumentList $args -PassThru -WindowStyle Hidden
  if (-not $p.WaitForExit($TimeoutMs)) {
    try { $p.Kill() } catch {}
    throw "SumatraPDF timed out printing to '$PrinterName'"
  }
  return $p.ExitCode
}

function Invoke-PrintToVerb {
  param([string]$PdfPath, [string]$PrinterName)
  Write-Host "  using PrintTo verb -> $PrinterName"
  $p = Start-Process -FilePath $PdfPath -Verb PrintTo -ArgumentList "`"$PrinterName`"" -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 10
  if ($p -and -not $p.HasExited) {
    try { $p.CloseMainWindow() | Out-Null } catch {}
  }
}

function Invoke-SumatraDefaultPrint {
  param([string]$Sumatra, [string]$PdfPath, [string]$PrinterName)
  Write-Host "  Sumatra -print-to-default after setting default printer"
  $prevDefault = $null
  try {
    $prevDefault = (Get-CimInstance Win32_Printer -Filter "Default=$true" -ErrorAction SilentlyContinue | Select-Object -First 1).Name
  } catch {}
  try {
    Start-Process -FilePath "$env:SystemRoot\System32\rundll32.exe" -ArgumentList @('printui.dll,PrintUIEntry', '/y', '/n', $PrinterName) -Wait -WindowStyle Hidden
    Start-Sleep -Seconds 1
    if (-not (Test-Path -LiteralPath $Sumatra)) { throw "SumatraPDF missing: $Sumatra" }
    $p = Start-Process -FilePath $Sumatra -ArgumentList @('-print-to-default', '-silent', '-exit-on-print', $PdfPath) -PassThru -WindowStyle Hidden
    if (-not $p.WaitForExit(45000)) {
      try { $p.Kill() } catch {}
      throw "SumatraPDF default-print timed out"
    }
    if ($p.ExitCode -ne 0) { throw "SumatraPDF default-print exit $($p.ExitCode)" }
  } finally {
    if ($prevDefault) {
      try {
        Start-Process -FilePath "$env:SystemRoot\System32\rundll32.exe" -ArgumentList @('printui.dll,PrintUIEntry', '/y', '/n', $prevDefault) -Wait -WindowStyle Hidden
      } catch {}
    }
  }
}

function Print-PdfToPrinter {
  param(
    [Parameter(Mandatory = $true)][string]$PdfPath,
    [Parameter(Mandatory = $true)][string]$PrinterName
  )
  if (-not (Test-Path -LiteralPath $PdfPath)) {
    throw "PDF missing: $PdfPath"
  }

  Ensure-PrinterReady -PrinterName $PrinterName

  $errors = New-Object System.Collections.Generic.List[string]
  $sumatra = Get-SumatraExe

  function Finish-Ok {
    Confirm-SpoolAccepted -PrinterName $PrinterName -PdfPath $PdfPath
  }

  # 1) Sumatra direct -print-to (one attempt with fit)
  if ($sumatra) {
    Write-Host "  using SumatraPDF: $sumatra"
    try {
      $code = Invoke-SumatraPrint -Sumatra $sumatra -PdfPath $PdfPath -PrinterName $PrinterName -PrintSettings 'fit'
      if ($code -eq 0) { Finish-Ok; return }
      $errors.Add("SumatraPDF exit $code (fit) to '$PrinterName'")
      Write-Warning "  $($errors[$errors.Count-1])"
    } catch {
      $errors.Add($_.Exception.Message)
      Write-Warning "  $($_.Exception.Message)"
    }
  } else {
    $errors.Add('SumatraPDF.exe not found in kit')
  }

  # 2) Adobe /t
  $acro = Get-ChildItem -Path @(
    "$env:ProgramFiles\Adobe",
    "${env:ProgramFiles(x86)}\Adobe"
  ) -Recurse -Include 'AcroRd32.exe', 'Acrobat.exe' -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($acro) {
    try {
      Write-Host "  using Adobe: $($acro.FullName)"
      $p = Start-Process -FilePath $acro.FullName -ArgumentList @('/t', $PdfPath, $PrinterName) -PassThru -WindowStyle Hidden
      if (-not $p.WaitForExit(45000)) {
        try { $p.Kill() } catch {}
        throw "Adobe timed out printing to '$PrinterName'"
      }
      Finish-Ok
      return
    } catch {
      $errors.Add($_.Exception.Message)
      Write-Warning "  $($_.Exception.Message)"
    }
  }

  # 3) Windows PrintTo verb (Edge/Adobe PDF association)
  try {
    Invoke-PrintToVerb -PdfPath $PdfPath -PrinterName $PrinterName
    Finish-Ok
    return
  } catch {
    $errors.Add("PrintTo: $($_.Exception.Message)")
    Write-Warning "  PrintTo failed: $($_.Exception.Message)"
  }

  # 4) Set as default + Sumatra -print-to-default
  if ($sumatra) {
    try {
      Invoke-SumatraDefaultPrint -Sumatra $sumatra -PdfPath $PdfPath -PrinterName $PrinterName
      Finish-Ok
      return
    } catch {
      $errors.Add($_.Exception.Message)
      Write-Warning "  $($_.Exception.Message)"
    }
  }

  throw ("Print failed v2026-08-06e: " + ($errors -join ' | '))
}

try { Send-Discovered } catch { Write-Warning $_.Exception.Message }

while ($true) {
  $job = $null
  try {
    $poll = Invoke-RestMethod -Method Get -Uri "$BaseUrl/api/print/agent/poll" -Headers $headers
    if ($poll.discoverRequested) { Send-Discovered }
    if ($poll.globalEnabled -eq $false) {
      Start-Sleep -Seconds $PollSeconds
      continue
    }
    if ($poll.job) {
      $job = $poll.job
      Write-Host "$(Get-Date -Format o) Printing $($job.id) -> $($job.windowsPrinterName)"
      $pdfPath = Join-Path $WorkDir "$($job.id).pdf"
      Invoke-WebRequest -Uri "$BaseUrl$($job.pdfPath)" -Headers $headers -OutFile $pdfPath
      if (-not $job.windowsPrinterName) {
        throw "Job has no windowsPrinterName. Set it on Printers in the console."
      }
      $winName = [string]$job.windowsPrinterName
      $installed = Get-Printer -Name $winName -ErrorAction SilentlyContinue
      if (-not $installed) {
        $available = @(Get-Printer | ForEach-Object { $_.Name }) -join ', '
        throw "Windows printer not found: '$winName'. Installed now: $available"
      }
      Print-PdfToPrinter -PdfPath $pdfPath -PrinterName $winName
      Complete-Job -JobId $job.id -Ok $true -ErrorText $null
      Write-Host "  done"
    }
  } catch {
    Write-Warning $_.Exception.Message
    if ($job -and $job.id) {
      try { Complete-Job -JobId $job.id -Ok $false -ErrorText $_.Exception.Message } catch {}
    }
  }
  Start-Sleep -Seconds $PollSeconds
}
