# Copy SumatraPDF from the kit folder to a local trusted path.
param(
  [string]$KitRoot = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$kit = Join-Path $KitRoot 'SumatraPDF.exe'
$dir = Join-Path $env:LOCALAPPDATA 'OrderAssistPrint'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$dst = Join-Path $dir 'SumatraPDF.exe'

if (-not (Test-Path -LiteralPath $kit)) {
  Write-Host "Kit SumatraPDF.exe missing at $kit - agent can download later if needed."
  exit 0
}

Copy-Item -LiteralPath $kit -Destination $dst -Force
try { Unblock-File -LiteralPath $dst -ErrorAction SilentlyContinue } catch {}
try { Remove-Item -LiteralPath ($dst + ':Zone.Identifier') -Force -ErrorAction SilentlyContinue } catch {}
Write-Host "Local SumatraPDF ready: $dst"
