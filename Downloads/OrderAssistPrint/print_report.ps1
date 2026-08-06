<#
.SYNOPSIS
  Mode C - local test print from a folder (no OrderAssist queue).

.DESCRIPTION
  For wipe/reinstall/test PCs where you just want to print a report.
  Asks whether to print, then lets you pick a file or uses .\outbox.

.EXAMPLE
  .\print_report.ps1
  .\print_report.ps1 -Path .\outbox\report.pdf
  .\print_report.ps1 -Path .\outbox -Printer "Brother QL-820NWB"
#>
param(
  [string]$Path,
  [string]$Printer
)

$ErrorActionPreference = "Stop"
$Root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
Set-Location $Root
$outbox = Join-Path $Root "outbox"
New-Item -ItemType Directory -Force -Path $outbox | Out-Null

function Read-Config {
  $cfgPath = Join-Path $Root "config.json"
  if (-not (Test-Path $cfgPath)) { return @{} }
  try { return Get-Content $cfgPath -Raw | ConvertFrom-Json } catch { return @{} }
}

$cfg = Read-Config
if (-not $Printer) { $Printer = [string]$cfg.DefaultPrinter }

Write-Host ""
Write-Host "OrderAssist print report (C - local / testing)"
Write-Host "Folder: $Root"
Write-Host ""

$answer = Read-Host "Do you want to print something now? (Y/N)"
if ($answer -notmatch '^(y|yes)$') {
  Write-Host "Skipped printing."
  exit 0
}

if (-not $Path) {
  Write-Host "1) Pick a file"
  Write-Host "2) Use newest file in .\outbox"
  Write-Host "3) Type a path"
  $choice = Read-Host "Choice (1/2/3)"
  switch ($choice) {
    "1" {
      Add-Type -AssemblyName System.Windows.Forms | Out-Null
      $dlg = New-Object System.Windows.Forms.OpenFileDialog
      $dlg.InitialDirectory = $outbox
      $dlg.Filter = "Documents|*.pdf;*.txt;*.png;*.jpg;*.jpeg;*.docx|All files|*.*"
      if ($dlg.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
        Write-Host "Cancelled."
        exit 0
      }
      $Path = $dlg.FileName
    }
    "2" {
      $file = Get-ChildItem -Path $outbox -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
      if (-not $file) { throw "outbox is empty. Drop a PDF/report into $outbox first." }
      $Path = $file.FullName
    }
    default {
      $Path = Read-Host "Full path to file or folder"
    }
  }
}

if (-not (Test-Path -LiteralPath $Path)) {
  throw "Path not found: $Path"
}

$item = Get-Item -LiteralPath $Path
if ($item.PSIsContainer) {
  $file = Get-ChildItem -Path $item.FullName -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $file) { throw "Folder has no files: $($item.FullName)" }
  $Path = $file.FullName
  Write-Host "Using newest in folder: $Path"
}

Write-Host ""
Write-Host "Installed printers:"
Get-Printer | Format-Table Name, DriverName, PortName -AutoSize

if (-not $Printer) {
  $Printer = Read-Host "Windows printer name (blank = default printer)"
}

Write-Host "Printing: $Path"
if ($Printer) {
  Write-Host "Printer : $Printer"
  Start-Process -FilePath $Path -Verb PrintTo -ArgumentList "`"$Printer`"" -WindowStyle Hidden
} else {
  Write-Host "Printer : (Windows default)"
  Start-Process -FilePath $Path -Verb Print -WindowStyle Hidden
}

Start-Sleep -Seconds 2
Write-Host "Print command sent."
