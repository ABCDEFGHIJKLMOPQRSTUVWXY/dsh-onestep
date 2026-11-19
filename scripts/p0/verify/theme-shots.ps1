# Dual-theme screenshots (S10): open the same instance with light / dark prefers-color-scheme,
# capture one PNG + one JSON each.
# Precondition: DSH theme preference is "system" (default). Dark theme = body[data-ds-dark-theme]
# driven by matchMedia. If the profile pins light/dark, JSON theme.source shows it and contrast=false.
#
# Usage (repo root, Windows PowerShell 5.1 or pwsh 7):
#   powershell -NoProfile -File scripts/p0/verify/theme-shots.ps1
#   powershell -NoProfile -File scripts/p0/verify/theme-shots.ps1 -Viewport 1280x800
#   powershell -NoProfile -File scripts/p0/verify/theme-shots.ps1 -Viewport 1920x1080 -OutDir artifacts/p0/verify/theme-1920
#
# Outputs: <OutDir>/theme-light.png, theme-dark.png, theme-light.json, theme-dark.json;
# stdout prints a summary JSON. Exit 0 = contrast between light/dark detected; 6 = no contrast.

param(
  [string]$UrlFile = 'artifacts/p0/server-url.txt',
  [string]$OutDir = 'artifacts/p0/verify',
  [string]$Viewport = '1440x900'
)

$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$driver = Join-Path $PSScriptRoot 'playwright-driver.mjs'
if (-not (Test-Path $driver)) { throw "driver not found: $driver" }

$urlFileAbs = if ([System.IO.Path]::IsPathRooted($UrlFile)) { $UrlFile } else { Join-Path $repo $UrlFile }
$outAbs = if ([System.IO.Path]::IsPathRooted($OutDir)) { $OutDir } else { Join-Path $repo $OutDir }
New-Item -ItemType Directory -Force -Path $outAbs | Out-Null

$rows = @()
foreach ($scheme in @('light', 'dark')) {
  $json = Join-Path $outAbs "theme-$scheme.json"
  $png = Join-Path $outAbs "theme-$scheme.png"
  & node $driver screenshot --url-file $urlFileAbs --color-scheme $scheme --viewport $Viewport --screenshot $png --out $json --quiet
  if ($LASTEXITCODE -ne 0) {
    Write-Host "theme-shots: scheme=$scheme failed exit=$LASTEXITCODE"
    exit $LASTEXITCODE
  }
  $r = Get-Content -Raw -Encoding UTF8 -Path $json | ConvertFrom-Json
  $rows += [pscustomobject]@{
    scheme   = $scheme
    darkAttr = $r.theme.darkAttr
    source   = $r.theme.source
    bgBase   = $r.theme.bgBase
    bodyBg   = $r.theme.bodyBg
    png      = $png
    bytes    = $r.screenshot.bytes
  }
}

$rows | Format-Table -AutoSize

$contrast = ($rows[0].bodyBg -ne $rows[1].bodyBg)
$summary = [pscustomobject]@{
  ok       = $true
  viewport = $Viewport
  shots    = $rows
  contrast = $contrast
  note     = if ($contrast) { 'dual theme works: light/dark body backgrounds differ' } else { 'dual theme NOT effective: check instance theme preference is system (theme.source in JSON)' }
}
Write-Host ($summary | ConvertTo-Json -Depth 5)

if (-not $contrast) { exit 6 }
exit 0
