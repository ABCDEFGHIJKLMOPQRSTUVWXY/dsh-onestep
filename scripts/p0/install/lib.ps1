# Shared helpers for the P0-B isolated-profile install harness (Windows PowerShell 5.1 compatible).
# Dot-source this file:  . "$PSScriptRoot\lib.ps1"
# Scope: only the profile named below and artifacts/p0b. Never touches the desktop profile,
# the Lead's onestep-p0 instance, or the DeepSeek Harness desktop app.

$script:RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$script:DshHome = Join-Path $env:USERPROFILE '.dsh'
# DSH 安装目录：可用环境变量 DSH_INSTALL_DIR 覆盖，默认取桌面应用的常规安装位置。
$script:DshRoot = if ($env:DSH_INSTALL_DIR) { $env:DSH_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness' }
$script:DshExe = Join-Path $script:DshRoot 'DeepSeek Harness.exe'
$script:DshCli = Join-Path $script:DshRoot 'resources\runtime\cli\bin\dsh.cmd'
$script:DshCliJs = Join-Path $script:DshRoot 'resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
$script:DefaultProfile = 'onestep-p0b'
$script:ArtifactDir = Join-Path $script:RepoRoot 'artifacts\p0b'
$script:HelloPluginDir = Join-Path $script:RepoRoot 'tmp\p0b-hello-plugin'
$script:HelloPackage = 'onestep-p0b-hello'

function Initialize-ArtifactDir {
    if (-not (Test-Path $script:ArtifactDir)) { New-Item -ItemType Directory -Force -Path $script:ArtifactDir | Out-Null }
}

function Get-ProfileDir([string]$ProfileName) {
    if ([string]::IsNullOrWhiteSpace($ProfileName)) { $ProfileName = $script:DefaultProfile }
    return (Join-Path (Join-Path $script:DshHome 'profiles') $ProfileName)
}

function Get-StatePath([string]$ProfileName) {
    Initialize-ArtifactDir
    return (Join-Path $script:ArtifactDir ("server-{0}.json" -f $ProfileName))
}

function Assert-SafeProfile([string]$ProfileName) {
    # Hard stop: this harness may only ever touch the isolated profile.
    if ([string]::IsNullOrWhiteSpace($ProfileName)) { throw 'profile name is empty' }
    if ($ProfileName -ieq 'desktop') { throw 'refusing to touch the desktop profile' }
    if ($ProfileName -ieq 'web' -or $ProfileName -ieq 'headless') { throw "refusing to touch shipped profile '$ProfileName'" }
    if ($ProfileName -notmatch '^onestep-p0b$') { throw "refusing profile '$ProfileName': only onestep-p0b is allowed for this harness" }
    $dir = Get-ProfileDir $ProfileName
    $expected = Join-Path (Join-Path $script:DshHome 'profiles') 'onestep-p0b'
    if ($dir -ne $expected) { throw "resolved profile dir '$dir' != '$expected'" }
    return $dir
}

function Get-DshServerProcesses([string]$ProfileName) {
    # A real profile server is: DeepSeek Harness.exe --expose-internals "<...>\cli.js" <profile> ...
    # Explicitly exclude agent tool runners (subprocess-local/runner.js) whose command line
    # quotes a script that merely mentions the profile name.
    if ([string]::IsNullOrWhiteSpace($ProfileName)) { $ProfileName = $script:DefaultProfile }
    $pattern = '--expose-internals\s+"[^"]*cli\.js"\s+' + [regex]::Escape($ProfileName) + '(?:\s|$)'
    $all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
    $hits = @()
    foreach ($p in $all) {
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
            try {
                $txt = Get-Content $OutFile -Raw -ErrorAction Stop
            } catch {
                continue
            }
            if ($txt -match 'dsh web: (http://\S+)') { return $Matches[1] }
        }
    }
    return $null
}

function Start-DshServer {
    param(
        [string]$ProfileName = $script:DefaultProfile,
        [int]$Port = 0,
        [string]$Tag = 'boot',
        [int]$TimeoutSec = 180,
        [string]$FromDefaultProfile = '',   # pass 'web' only when the profile must be (re)created
        [switch]$Recreate
    )
    Assert-SafeProfile $ProfileName | Out-Null
    Initialize-ArtifactDir
    $existing = Get-DshServerProcesses $ProfileName
    if (@($existing).Count -gt 0) { throw "profile '$ProfileName' already has a running server (pid $($existing[0].ProcessId)); stop it first" }

    $outLog = Join-Path $script:ArtifactDir ("{0}.out.log" -f $Tag)
    $errLog = Join-Path $script:ArtifactDir ("{0}.err.log" -f $Tag)
    Remove-Item $outLog, $errLog -Force -ErrorAction SilentlyContinue

    $argList = @('--expose-internals', ('"' + $script:DshCliJs + '"'), $ProfileName)
    if ($Recreate) {
        if ([string]::IsNullOrWhiteSpace($FromDefaultProfile)) { throw '-Recreate requires -FromDefaultProfile <shipped template>' }
        $argList += @('--from-default-profile', $FromDefaultProfile)
    }
    $argList += @('--no-open', '--port', [string]$Port)

    $env:ELECTRON_RUN_AS_NODE = '1'
    $proc = Start-Process -FilePath $script:DshExe -ArgumentList $argList `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru -WindowStyle Hidden
    $script:LastStartedPid = $proc.Id

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
        profile    = $ProfileName
        pid        = $proc.Id
        url        = $url
        token      = $token
        outLog     = $outLog
        errLog     = $errLog
        startedAt  = (Get-Date).ToString('o')
        commandLine = ('--expose-internals ' + $script:DshCliJs + ' ' + ($argList -join ' '))
    }
    $statePath = Get-StatePath $ProfileName
    ($info | ConvertTo-Json -Depth 5) | Set-Content -Path $statePath -Encoding UTF8
    return [pscustomobject]$info
}

function Read-DshServerState([string]$ProfileName = $script:DefaultProfile) {
    $path = Get-StatePath $ProfileName
    if (-not (Test-Path $path)) { return $null }
    return (Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Stop-DshServer {
    param(
        [string]$ProfileName = $script:DefaultProfile,
        [int]$WaitSec = 15
    )
    Assert-SafeProfile $ProfileName | Out-Null
    $targets = @(Get-DshServerProcesses $ProfileName)
    $stopped = @()
    foreach ($t in $targets) {
        # Last-moment verification: same PID, same command line, still the profile server.
        $cmd = [string]$t.CommandLine
        $ok = ($cmd -match ('--expose-internals\s+"[^"]*cli\.js"\s+' + [regex]::Escape($ProfileName) + '(?:\s|$)')) -and
              (-not $cmd.Contains('subprocess-local')) -and (-not $cmd.Contains('--type='))
        if (-not $ok) {
            Write-Warning ("REFUSE to stop pid {0}: command line does not match the isolated profile server" -f $t.ProcessId)
            continue
        }
        Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue
        $stopped += $t.ProcessId
    }
    # Wait until no matching server process remains.
    $deadline = (Get-Date).AddSeconds($WaitSec)
    while ((Get-Date) -lt $deadline) {
        $left = @(Get-DshServerProcesses $ProfileName)
        if ($left.Count -eq 0) { break }
        Start-Sleep -Milliseconds 250
    }
    $left = @(Get-DshServerProcesses $ProfileName)
    return [pscustomobject]@{ stoppedPids = $stopped; remaining = $left.Count }
}

function Invoke-Curl {
    param(
        [string]$Target,
        [string[]]$Arguments = @(),
        [string]$OutFile = $null
    )
    $common = @('-sS')
    if (-not [string]::IsNullOrEmpty($OutFile)) { $common += @('-o', $OutFile) }
    $all = $common + $Arguments + @($Target)
    $output = & curl.exe @all 2>&1
    $code = $LASTEXITCODE
    return [pscustomobject]@{ exitCode = $code; output = ($output | Out-String).Trim() }
}

function Get-ServerBase([string]$ServerUrl) {
    return (($ServerUrl -replace '\?.*$', '').TrimEnd('/'))
}

function Connect-DshBrowserSession {
    # The token URL answers 303 + Set-Cookie; the rest of the session rides that cookie.
    param([string]$ServerUrl, [string]$JarFile)
    if (Test-Path $JarFile) { Remove-Item $JarFile -Force }
    $r = Invoke-Curl -Target $ServerUrl -Arguments @('-L', '-c', $JarFile, '-b', $JarFile, '-o', 'NUL')
    return $r
}

function Get-DshBootGraph {
    param(
        [string]$ServerUrl,
        [string]$JarFile,
        [string]$Tag = 'boot',
        [switch]$KeepHtml
    )
    Initialize-ArtifactDir
    $base = Get-ServerBase $ServerUrl
    $htmlPath = Join-Path $script:ArtifactDir ("{0}.index.html" -f $Tag)
    $r = Invoke-Curl -Target ($base + '/') -Arguments @('-L', '-c', $JarFile, '-b', $JarFile, '-o', $htmlPath, '-w', '%{http_code}')
    if ($r.exitCode -ne 0) { throw "curl failed fetching / (exit $($r.exitCode)): $($r.output)" }
    if ($r.output -notmatch '^200$') { throw "GET / answered HTTP $($r.output) (expected 200)" }
    $html = Get-Content $htmlPath -Raw -Encoding UTF8
    $marker = 'globalThis["__DSH_BOOT__"] = '
    $idx = $html.IndexOf($marker)
    if ($idx -lt 0) { throw 'no __DSH_BOOT__ payload in index HTML' }
    $start = $idx + $marker.Length
    $depth = 0; $i = $start; $inStr = $false; $esc = $false; $end = -1
    while ($i -lt $html.Length) {
        $c = $html[$i]
        if ($inStr) {
            if ($esc) { $esc = $false }
            elseif ($c -eq '\') { $esc = $true }
            elseif ($c -eq '"') { $inStr = $false }
        } else {
            if ($c -eq '"') { $inStr = $true }
            elseif ($c -eq '{') { $depth++ }
            elseif ($c -eq '}') { $depth--; if ($depth -eq 0) { $end = $i; break } }
        }
        $i++
    }
    if ($end -lt 0) { throw 'unterminated __DSH_BOOT__ JSON' }
    $jsonText = $html.Substring($start, $end - $start + 1)
    $graphPath = Join-Path $script:ArtifactDir ("{0}.graph.json" -f $Tag)
    $jsonText | Set-Content -Path $graphPath -Encoding UTF8
    $graph = $jsonText | ConvertFrom-Json
    if (-not $KeepHtml) { }
    return [pscustomobject]@{ html = $html; htmlPath = $htmlPath; graph = $graph; graphPath = $graphPath; base = $base }
}

function Get-BundleFetch {
    param(
        [string]$ServerUrl,
        [string]$JarFile,
        [string]$RelativeUrl,
        [string]$SaveBodyPath = ''
    )
    $base = Get-ServerBase $ServerUrl
    $target = $base + '/' + $RelativeUrl.TrimStart('/')
    if ([string]::IsNullOrWhiteSpace($SaveBodyPath)) {
        $SaveBodyPath = Join-Path $script:ArtifactDir ('_bundle_' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.js')
    }
    $r = Invoke-Curl -Target $target -Arguments @('-L', '-c', $JarFile, '-b', $JarFile, '-o', $SaveBodyPath, '-w', '%{http_code}')
    $status = 0
    if ($r.output -match '(\d{3})') { $status = [int]$Matches[1] }
    $len = 0; $text = ''
    if ((Test-Path $SaveBodyPath) -and ((Get-Item $SaveBodyPath).Length -gt 0)) {
        $len = (Get-Item $SaveBodyPath).Length
        $text = Get-Content $SaveBodyPath -Raw -Encoding UTF8
    }
    return [pscustomobject]@{ status = $status; bytes = $len; text = $text; target = $target; bodyPath = $SaveBodyPath }
}

function Get-HttpStatus {
    param([string]$ServerUrl, [string]$JarFile, [string]$PathAndQuery)
    $base = Get-ServerBase $ServerUrl
    $r = Invoke-Curl -Target ($base + '/' + $PathAndQuery.TrimStart('/')) -Arguments @('-L', '-c', $JarFile, '-b', $JarFile, '-o', 'NUL', '-w', '%{http_code}')
    if ($r.output -match '(\d{3})') { return [int]$Matches[1] }
    return -1
}

function Get-ProfileManifest([string]$ProfileName = $script:DefaultProfile) {
    $dir = Get-ProfileDir $ProfileName
    $path = Join-Path $dir 'package.json'
    if (-not (Test-Path $path)) { return $null }
    return (Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Copy-ProfileManifest([string]$ProfileName, [string]$Tag) {
    $dir = Get-ProfileDir $ProfileName
    $src = Join-Path $dir 'package.json'
    Initialize-ArtifactDir
    $dst = Join-Path $script:ArtifactDir ("package.json.{0}.json" -f $Tag)
    Copy-Item $src $dst -Force
    return $dst
}

function Set-ProfileBundle {
    param(
        [string]$ProfileName = $script:DefaultProfile,
        [string]$PackageName = $script:HelloPackage,
        [ValidateSet('add', 'remove')][string]$Action = 'add',
        [string]$BackupTag = ''
    )
    $dir = Get-ProfileDir $ProfileName
    $path = Join-Path $dir 'package.json'
    if ($BackupTag -ne '') { Copy-ProfileManifest $ProfileName $BackupTag | Out-Null }
    $raw = Get-Content $path -Raw -Encoding UTF8
    $manifest = $raw | ConvertFrom-Json
    if ($null -eq $manifest.dsh) { $manifest | Add-Member -MemberType NoteProperty -Name dsh -Value ([pscustomobject]@{}) }
    if ($null -eq $manifest.dsh.profile) { $manifest.dsh | Add-Member -MemberType NoteProperty -Name profile -Value ([pscustomobject]@{}) }
    if ($null -eq $manifest.dsh.profile.bundles) {
        $manifest.dsh.profile | Add-Member -MemberType NoteProperty -Name bundles -Value @()
    }
    $list = @()
    foreach ($b in $manifest.dsh.profile.bundles) { $list += [string]$b }
    if ($Action -eq 'add') {
        if ($list -notcontains $PackageName) { $list += $PackageName }
    } else {
        $list = @($list | Where-Object { $_ -ne $PackageName })
    }
    $manifest.dsh.profile.bundles = $list
    $out = $manifest | ConvertTo-Json -Depth 20
    [IO.File]::WriteAllText($path, $out + "`n", (New-Object System.Text.UTF8Encoding($false)))
    return $list
}

function Get-ProfileTreeSnapshot([string]$ProfileName = $script:DefaultProfile, [string]$Tag = 'snapshot') {
    $dir = Get-ProfileDir $ProfileName
    Initialize-ArtifactDir
    $lines = @()
    $lines += '# profile dir: ' + $dir
    if (Test-Path $dir) {
        Get-ChildItem $dir -Force | Sort-Object Name | ForEach-Object {
            $lines += ('{0}  {1}  {2}' -f $_.Mode, $_.Length, $_.Name)
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
            $hello = Join-Path $nm $script:HelloPackage
            if (Test-Path $hello) {
                $item = Get-Item $hello -Force
                $lines += ('# hello link: LinkType={0} Target={1}' -f $item.LinkType, ($item.Target -join ','))
            } else {
                $lines += '# hello link: absent'
            }
        } else {
            $lines += '(no node_modules)'
        }
    } else {
        $lines += '(profile dir absent)'
    }
    $outPath = Join-Path $script:ArtifactDir ('profile-{0}.txt' -f $Tag)
    [IO.File]::WriteAllLines($outPath, $lines, (New-Object System.Text.UTF8Encoding($false)))
    return [pscustomobject]@{ text = ($lines -join "`n"); path = $outPath }
}

function Get-FileFingerprint([string]$Path) {
    if (-not (Test-Path $Path)) { return $null }
    $i = Get-Item $Path
    $hash = (Get-FileHash $Path -Algorithm SHA1).Hash.Substring(0, 12)
    return [pscustomobject]@{
        path = $i.FullName
        size = $i.Length
        mtime = $i.LastWriteTimeUtc.ToString('o')
        sha1 = $hash
    }
}

function Get-ServerStdoutTail([string]$LogPath, [int]$Lines = 80) {
    if (-not (Test-Path $LogPath)) { return '' }
    return (Get-Content $LogPath -Tail $Lines -ErrorAction SilentlyContinue | Out-String)
}
