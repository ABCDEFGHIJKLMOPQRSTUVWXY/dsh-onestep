# P3-1 probe: start / stop / status the isolated profile 'onestep-p0' (port 4650).
# ASCII only (Windows PowerShell 5.1 reads a UTF-8 .ps1 without BOM as ANSI).
# Scope: profile 'onestep-p0' and artifacts/p3 only. Refuses every other profile.
# Usage:
#   pwsh -NoProfile -File scripts/p3/probe/server.ps1 -Action start
#   pwsh -NoProfile -File scripts/p3/probe/server.ps1 -Action status
#   pwsh -NoProfile -File scripts/p3/probe/server.ps1 -Action stop
param(
    [Parameter(Mandatory = $true)][ValidateSet('start', 'stop', 'status')][string]$Action,
    [int]$Port = 4650,
    [int]$TimeoutSec = 180,
    [string]$Tag = 'boot'
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$DshHome = Join-Path $env:USERPROFILE '.dsh'
# DSH 安装目录：可用环境变量 DSH_INSTALL_DIR 覆盖，默认取桌面应用的常规安装位置。
$DshRoot = if ($env:DSH_INSTALL_DIR) { $env:DSH_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness' }
$DshExe = Join-Path $DshRoot 'DeepSeek Harness.exe'
$DshCliJs = Join-Path $DshRoot 'resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
$Profile = 'onestep-p0'
$ArtifactDir = Join-Path $RepoRoot 'artifacts\p3'
$ProbeDir = Join-Path $ArtifactDir 'probe'
$LogDir = Join-Path $ProbeDir 'logs'

function Assert-SafeProfile {
    if ($Profile -ieq 'desktop') { throw 'refusing to touch the desktop profile' }
    if ($Profile -ieq 'web' -or $Profile -ieq 'headless') { throw "refusing to touch shipped profile '$Profile'" }
    if ($Profile -notmatch '^onestep-p0$') { throw "refusing profile '$Profile': only onestep-p0 is allowed for the P3 probe" }
    $dir = Join-Path (Join-Path $DshHome 'profiles') $Profile
    $expected = Join-Path (Join-Path $DshHome 'profiles') 'onestep-p0'
    if ($dir -ne $expected) { throw "resolved profile dir '$dir' != '$expected'" }
    return $dir
}

function Get-ServerProcesses {
    # A real profile server: DeepSeek Harness.exe --expose-internals "<...>\cli.js" onestep-p0 ...
    $pattern = '--expose-internals\s+"[^"]*cli\.js"\s+' + [regex]::Escape($Profile) + '(?:\s|$)'
    $hits = @()
    foreach ($p in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
        if ($p.Name -ne 'DeepSeek Harness.exe') { continue }
        $cmd = [string]$p.CommandLine
        if ([string]::IsNullOrEmpty($cmd)) { continue }
        if ($cmd.Contains('subprocess-local')) { continue }
        if ($cmd.Contains('--type=')) { continue }
        if ($cmd -notmatch $pattern) { continue }
        $hits += $p
    }
    return $hits
}

function Initialize-Dirs {
    foreach ($d in @($ArtifactDir, $ProbeDir, $LogDir)) {
        if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
    }
}

function Mask-Url([string]$Url) { return ($Url -replace '([?&]token=)[^&#\s]+', '$1***') }

function Write-Json([string]$Name, $Object) {
    $path = Join-Path $ProbeDir $Name
    ([IO.File]::WriteAllText($path, (($Object | ConvertTo-Json -Depth 8) + "`n"), (New-Object System.Text.UTF8Encoding($false))))
    return $path
}

function Start-Server {
    Initialize-Dirs
    $existing = @(Get-ServerProcesses)
    if ($existing.Count -gt 0) {
        $url = Get-SavedUrl
        Write-Host ('[p3-server] already running pid=' + $existing[0].ProcessId + ' url=' + $(if ($url) { Mask-Url $url } else { '(unknown)' }))
        return
    }
    Assert-SafeProfile | Out-Null
    if ($Port -ne 4650) { throw "refusing port ${Port}: the P3 probe instance is pinned to 4650" }
    $outLog = Join-Path $LogDir ("{0}.out.log" -f $Tag)
    $errLog = Join-Path $LogDir ("{0}.err.log" -f $Tag)
    Remove-Item $outLog, $errLog -Force -ErrorAction SilentlyContinue

    $argList = @('--expose-internals', ('"' + $DshCliJs + '"'), $Profile, '--no-open', '--port', [string]$Port)
    $env:ELECTRON_RUN_AS_NODE = '1'
    $proc = Start-Process -FilePath $DshExe -ArgumentList $argList `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru -WindowStyle Hidden

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $url = $null
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 400
        if (Test-Path $outLog) {
            try { $txt = Get-Content $outLog -Raw -ErrorAction Stop } catch { continue }
            if ($txt -match 'dsh web: (http://\S+)') { $url = $Matches[1]; break }
        }
    }
    if ($null -eq $url) {
        $errTail = ''
        if (Test-Path $errLog) { $errTail = (Get-Content $errLog -Tail 60 -ErrorAction SilentlyContinue | Out-String) }
        throw "server did not print a URL within ${TimeoutSec}s; pid=$($proc.Id)`n--- stderr ---`n$errTail"
    }
    $urlFile = Join-Path $ArtifactDir 'server-url.txt'
    ([IO.File]::WriteAllText($urlFile, ($url + "`n# profile=$Profile; token rotates on every restart; read this file fresh`n"), (New-Object System.Text.UTF8Encoding($false))))
    $info = [ordered]@{
        ok = $true; profile = $Profile; pid = $proc.Id; port = $Port
        urlMasked = (Mask-Url $url); outLog = $outLog; errLog = $errLog
        startedAt = (Get-Date).ToString('o')
    }
    Write-Json ('server-start-' + $Tag + '.json') $info | Out-Null
    Write-Host ('[p3-server] started pid=' + $proc.Id + ' ' + (Mask-Url $url))
    Write-Host ('[p3-server] urlFile=' + $urlFile + ' logs=' + $outLog)
}

function Get-SavedUrl {
    $urlFile = Join-Path $ArtifactDir 'server-url.txt'
    if (-not (Test-Path $urlFile)) { return $null }
    $raw = (Get-Content $urlFile -Raw -Encoding UTF8).Split("`n")[0].Trim()
    if ($raw -notmatch '^https?://') { return $null }
    return $raw
}

function Stop-Server {
    Assert-SafeProfile | Out-Null
    $targets = @(Get-ServerProcesses)
    $stopped = @()
    foreach ($t in $targets) {
        $cmd = [string]$t.CommandLine
        $ok = ($cmd -match ('--expose-internals\s+"[^"]*cli\.js"\s+' + [regex]::Escape($Profile) + '(?:\s|$)')) -and
              (-not $cmd.Contains('subprocess-local')) -and (-not $cmd.Contains('--type='))
        if (-not $ok) { Write-Warning ("REFUSE to stop pid {0}: command line does not match the profile server" -f $t.ProcessId); continue }
        Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue
        $stopped += $t.ProcessId
    }
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        if (@(Get-ServerProcesses).Count -eq 0) { break }
        Start-Sleep -Milliseconds 250
    }
    $left = @(Get-ServerProcesses).Count
    Write-Host ('[p3-server] stopped pids=' + ($stopped -join ',') + ' remaining=' + $left)
    if ($left -ne 0) { exit 1 }
}

try {
    switch ($Action) {
        'start' { Start-Server; exit 0 }
        'stop' { Stop-Server; exit 0 }
        'status' {
            $procs = @(Get-ServerProcesses)
            $url = Get-SavedUrl
            $state = [ordered]@{
                profile = $Profile; port = $Port; running = ($procs.Count -gt 0)
                pids = @($procs | ForEach-Object { $_.ProcessId })
                urlMasked = $(if ($url) { Mask-Url $url } else { $null })
            }
            Write-Host ($state | ConvertTo-Json -Depth 5)
            exit 0
        }
    }
} catch {
    Write-Error ('[p3-server] FAILED: ' + $_.Exception.Message)
    exit 1
}
