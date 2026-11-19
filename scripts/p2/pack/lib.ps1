# P2-7 pack/release rehearsal helpers (Windows PowerShell 5.1 compatible; ASCII only).
# Dot-source from scripts/p2/pack/*.ps1:  . "$PSScriptRoot\lib.ps1"
# Hard scope: profile 'onestep-p2' (port 4661) and artifacts/p2/pack only.
# Refuses desktop / web / headless / onestep-p0 / onestep-p0b / any other profile.

$script:RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$script:DshHome = Join-Path $env:USERPROFILE '.dsh'
# DSH 安装目录：可用环境变量 DSH_INSTALL_DIR 覆盖，默认取桌面应用的常规安装位置。
$script:DshRoot = if ($env:DSH_INSTALL_DIR) { $env:DSH_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness' }
$script:DshExe = Join-Path $script:DshRoot 'DeepSeek Harness.exe'
$script:DshCli = Join-Path $script:DshRoot 'resources\runtime\cli\bin\dsh.cmd'
$script:DshCliJs = Join-Path $script:DshRoot 'resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
$script:Profile = 'onestep-p2'
$script:Port = 4661
$script:Package = 'dsh-onestep'
$script:ArtifactDir = Join-Path $script:RepoRoot 'artifacts\p2\pack'
$script:LogDir = Join-Path $script:ArtifactDir 'logs'

function Initialize-ArtifactDir {
    foreach ($d in @($script:ArtifactDir, $script:LogDir)) {
        if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
    }
}

function Get-ProfileDir([string]$ProfileName = $script:Profile) {
    return (Join-Path (Join-Path $script:DshHome 'profiles') $ProfileName)
}

function Assert-SafeProfile([string]$ProfileName) {
    if ([string]::IsNullOrWhiteSpace($ProfileName)) { throw 'profile name is empty' }
    if ($ProfileName -ieq 'desktop') { throw 'refusing to touch the desktop profile' }
    if ($ProfileName -ieq 'web' -or $ProfileName -ieq 'headless') { throw "refusing to touch shipped profile '$ProfileName'" }
    if ($ProfileName -notmatch '^onestep-p2$') { throw "refusing profile '$ProfileName': only onestep-p2 is allowed for this harness" }
    $dir = Get-ProfileDir $ProfileName
    $expected = Join-Path (Join-Path $script:DshHome 'profiles') 'onestep-p2'
    if ($dir -ne $expected) { throw "resolved profile dir '$dir' != '$expected'" }
    return $dir
}

function Get-DshServerProcesses([string]$ProfileName = $script:Profile) {
    # Real profile server: DeepSeek Harness.exe --expose-internals "<...>\cli.js" <profile> ...
    # Exclude agent tool runners (subprocess-local) and Electron helper subprocesses (--type=).
    $pattern = '--expose-internals\s+"[^"]*cli\.js"\s+' + [regex]::Escape($ProfileName) + '(?:\s|$)'
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

function Wait-DshServerUrl([string]$OutFile, [int]$TimeoutSec = 180) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 400
        if (Test-Path $OutFile) {
            try { $txt = Get-Content $OutFile -Raw -ErrorAction Stop } catch { continue }
            # Stop-Process redirect can leave partial reads; only accept a full URL line.
            if ($txt -match 'dsh web: (http://\S+)') { return $Matches[1] }
        }
    }
    return $null
}

function Get-StatePath([string]$ProfileName = $script:Profile) {
    Initialize-ArtifactDir
    return (Join-Path $script:ArtifactDir ("server-{0}.json" -f $ProfileName))
}

function Start-DshServer {
    param(
        [string]$Tag = 'boot',
        [int]$Port = $script:Port,
        [int]$TimeoutSec = 180,
        [string]$FromDefaultProfile = ''    # pass 'web' ONLY when the profile must be (re)created
    )
    Assert-SafeProfile $script:Profile | Out-Null
    Initialize-ArtifactDir
    $existing = @(Get-DshServerProcesses $script:Profile)
    if ($existing.Count -gt 0) { throw "profile '$($script:Profile)' already has a running server (pid $($existing[0].ProcessId)); stop it first" }
    if ($Port -ne $script:Port) { throw "refusing port ${Port}: harness is pinned to $($script:Port)" }

    $outLog = Join-Path $script:LogDir ("{0}.out.log" -f $Tag)
    $errLog = Join-Path $script:LogDir ("{0}.err.log" -f $Tag)
    Remove-Item $outLog, $errLog -Force -ErrorAction SilentlyContinue

    $argList = @('--expose-internals', ('"' + $script:DshCliJs + '"'), $script:Profile)
    if (-not [string]::IsNullOrWhiteSpace($FromDefaultProfile)) {
        $argList += @('--from-default-profile', $FromDefaultProfile)
    }
    $argList += @('--no-open', '--port', [string]$Port)

    $env:ELECTRON_RUN_AS_NODE = '1'
    $proc = Start-Process -FilePath $script:DshExe -ArgumentList $argList `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru -WindowStyle Hidden

    $url = Wait-DshServerUrl -OutFile $outLog -TimeoutSec $TimeoutSec
    if ($null -eq $url) {
        $errTail = ''
        if (Test-Path $errLog) { $errTail = (Get-Content $errLog -Tail 60 -ErrorAction SilentlyContinue | Out-String) }
        throw "server did not print a URL within ${TimeoutSec}s; pid=$($proc.Id)`n--- stderr ---`n$errTail"
    }
    $token = ''
    $m = [regex]::Match($url, 'token=([^&\s]+)')
    if ($m.Success) { $token = $m.Groups[1].Value }
    $info = [ordered]@{
        profile    = $script:Profile
        pid        = $proc.Id
        url        = $url
        token      = $token
        outLog     = $outLog
        errLog     = $errLog
        startedAt  = (Get-Date).ToString('o')
        recreate   = (-not [string]::IsNullOrWhiteSpace($FromDefaultProfile))
        commandLine = ('--expose-internals ' + $script:DshCliJs + ' ' + ($argList -join ' '))
    }
    $statePath = Get-StatePath
    ([IO.File]::WriteAllText($statePath, (($info | ConvertTo-Json -Depth 5) + "`n"), (New-Object System.Text.UTF8Encoding($false))))
    $urlFile = Join-Path $script:ArtifactDir 'server-url.txt'
    ([IO.File]::WriteAllText($urlFile, ($url + "`n# profile=$($script:Profile); token rotates on every restart; read this file fresh`n"), (New-Object System.Text.UTF8Encoding($false))))
    return [pscustomobject]$info
}

function Read-DshServerState {
    $path = Get-StatePath
    if (-not (Test-Path $path)) { return $null }
    return (Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Stop-DshServer {
    param([int]$WaitSec = 20)
    Assert-SafeProfile $script:Profile | Out-Null
    $targets = @(Get-DshServerProcesses $script:Profile)
    $stopped = @()
    foreach ($t in $targets) {
        $cmd = [string]$t.CommandLine
        $ok = ($cmd -match ('--expose-internals\s+"[^"]*cli\.js"\s+' + [regex]::Escape($script:Profile) + '(?:\s|$)')) -and
              (-not $cmd.Contains('subprocess-local')) -and (-not $cmd.Contains('--type='))
        if (-not $ok) { Write-Warning ("REFUSE to stop pid {0}: command line does not match the profile server" -f $t.ProcessId); continue }
        Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue
        $stopped += $t.ProcessId
    }
    $deadline = (Get-Date).AddSeconds($WaitSec)
    while ((Get-Date) -lt $deadline) {
        $left = @(Get-DshServerProcesses $script:Profile)
        if ($left.Count -eq 0) { break }
        Start-Sleep -Milliseconds 250
    }
    $left = @(Get-DshServerProcesses $script:Profile)
    return [pscustomobject]@{ stoppedPids = @($stopped); remaining = $left.Count }
}

function Get-ProfileManifest {
    $path = Join-Path (Get-ProfileDir) 'package.json'
    if (-not (Test-Path $path)) { return $null }
    return (Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Save-ProfileManifest([string]$Tag) {
    Initialize-ArtifactDir
    $src = Join-Path (Get-ProfileDir) 'package.json'
    $dst = Join-Path $script:ArtifactDir ("profile-package.{0}.json" -f $Tag)
    if (Test-Path $src) { Copy-Item $src $dst -Force; return $dst }
    return $null
}

function Get-ProfileTreeSnapshot([string]$Tag) {
    Initialize-ArtifactDir
    $dir = Get-ProfileDir
    $lines = @('# profile dir: ' + $dir)
    $lines += '# captured: ' + (Get-Date).ToString('o')
    if (Test-Path $dir) {
        Get-ChildItem $dir -Force | Sort-Object Name | ForEach-Object {
            $target = ''
            if ($_.LinkType) { $target = ' -> ' + ($_.Target -join ',') }
            $lines += ('{0}  {1}  {2}{3}' -f $_.Mode, $_.Length, $_.Name, $target)
        }
        $nm = Join-Path $dir 'node_modules'
        $lines += ''
        $lines += '# node_modules:'
        if (Test-Path $nm) {
            Get-ChildItem $nm -Force | Sort-Object Name | ForEach-Object {
                $target = ''
                if ($_.LinkType) { $target = ' -> ' + ($_.Target -join ',') }
                $lines += ('{0}  {1}{2}' -f $_.Mode, $_.Name, $target)
            }
        } else { $lines += '(no node_modules)' }
    } else {
        $lines += '(profile dir absent)'
    }
    $outPath = Join-Path $script:ArtifactDir ('profile-tree.{0}.txt' -f $Tag)
    ([IO.File]::WriteAllLines($outPath, $lines, (New-Object System.Text.UTF8Encoding($false))))
    return $outPath
}

function Invoke-DshPlugin {
    # Run `dsh plugin --profile onestep-p2 <args...>`; capture exit code + output to evidence log.
    param([string[]]$DshArgs = @(), [string]$Tag = 'plugin')
    Initialize-ArtifactDir
    $args = @('plugin', '--profile', $script:Profile) + $DshArgs
    $logPath = Join-Path $script:LogDir ("dsh-plugin-{0}.log" -f $Tag)
    $lines = @('# command: dsh.cmd ' + ($args -join ' '))
    $lines += '# startedAt: ' + (Get-Date).ToString('o')
    $text = (& $script:DshCli @args 2>&1 | Out-String)
    $code = $LASTEXITCODE
    $lines += $text.TrimEnd()
    $lines += '# exitCode: ' + $code
    $lines += '# finishedAt: ' + (Get-Date).ToString('o')
    ([IO.File]::WriteAllText($logPath, (($lines -join "`r`n") + "`r`n"), (New-Object System.Text.UTF8Encoding($false))))
    return [pscustomobject]@{ exitCode = $code; output = $text.Trim(); log = $logPath; args = $args }
}

function Write-JsonEvidence([string]$Name, $Object) {
    Initialize-ArtifactDir
    $path = Join-Path $script:ArtifactDir $Name
    $json = $Object | ConvertTo-Json -Depth 20
    ([IO.File]::WriteAllText($path, ($json + "`n"), (New-Object System.Text.UTF8Encoding($false))))
    return $path
}

function Get-ServerMatchingUrl([string]$UrlFile) {
    # Read URL file and masked form for console output.
    if (-not (Test-Path $UrlFile)) { return $null }
    $raw = (Get-Content $UrlFile -Raw -Encoding UTF8).Split("`n")[0].Trim()
    if ($raw -notmatch '^https?://') { return $null }
    return $raw
}

function Mask-Url([string]$Url) {
    return ($Url -replace '([?&]token=)[^&#\s]+', '$1***')
}
