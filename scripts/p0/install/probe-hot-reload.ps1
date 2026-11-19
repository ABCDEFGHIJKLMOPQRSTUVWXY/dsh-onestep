# Probe the hot-reload boundary of the isolated profile (server must already be running):
#   phase 1 - edit the installed client half (client.js) while the server runs, then
#             re-read the boot graph / bundle over HTTP WITHOUT restarting: does a page
#             refresh alone see the new code?
#   phase 2 - edit the host half (index.js) while the server runs: does the host plugin
#             re-apply (HMR) or keep running the old module?
# Files are restored at the end. A restart (start-server/stop-server in a separate step)
# is what makes a host-half change visible; this script never starts or stops the server.
#
# Usage: .\probe-hot-reload.ps1 -Tag hot
[CmdletBinding()]
param(
    [string]$ProfileName = 'onestep-p0b',
    [string]$Tag = 'hot',
    [int]$WaitSeconds = 10
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\lib.ps1"

$result = [ordered]@{ tag = $Tag; phases = [ordered]@{}; startedAt = (Get-Date).ToString('o'); ok = $false }
$clientJs = Join-Path $script:HelloPluginDir 'client.js'
$hostJs = Join-Path $script:HelloPluginDir 'index.js'

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}
function Read-Utf8([string]$Path) { return (Get-Content $Path -Raw -Encoding UTF8) }

try {
    Assert-SafeProfile $ProfileName | Out-Null
    Initialize-ArtifactDir
    if (-not (Test-Path $clientJs)) { throw "missing $clientJs" }
    if (-not (Test-Path $hostJs)) { throw "missing $hostJs" }
    $state = Read-DshServerState $ProfileName
    if ($null -eq $state) { throw 'no server state; start the server first' }
    if (@(Get-DshServerProcesses $ProfileName).Count -eq 0) { throw "profile server is not running (state pid $($state.pid))" }
    $jar = Join-Path $script:ArtifactDir ("cookies-{0}.txt" -f $Tag)
    Connect-DshBrowserSession -ServerUrl $state.url -JarFile $jar | Out-Null

    $clientOrig = Read-Utf8 $clientJs
    $hostOrig = Read-Utf8 $hostJs

    # --- baseline -----------------------------------------------------------
    $base = Get-DshBootGraph -ServerUrl $state.url -JarFile $jar -Tag ("{0}.baseline" -f $Tag)
    $baseEntry = @($base.graph.entries) | Where-Object { $_.id -eq $script:HelloPackage } | Select-Object -First 1
    if ($null -eq $baseEntry) { throw 'hello entry missing from the baseline boot graph' }
    $baseBundle = Get-BundleFetch -ServerUrl $state.url -JarFile $jar -RelativeUrl $baseEntry.url
    $baseBundlePath = Join-Path $script:ArtifactDir ("{0}.baseline.entry-bundle.js" -f $Tag)
    if ($baseBundle.bodyPath -ne $baseBundlePath) { Move-Item $baseBundle.bodyPath $baseBundlePath -Force -ErrorAction SilentlyContinue }
    $result.phases.baseline = [ordered]@{
        graphRev = $base.graph.rev; entryRev = $baseEntry.rev; entryUrl = $baseEntry.url
        bundleStatus = $baseBundle.status; bundleBytes = $baseBundle.bytes
        bundleHasV1Marker = $baseBundle.text.Contains('HELLO P0B')
        clientFile = Get-FileFingerprint $clientJs
        hostFile = Get-FileFingerprint $hostJs
        serverStdout = (Get-ServerStdoutTail $state.outLog 40)
    }
    Write-Host ("baseline: graphRev={0} entryRev={1} bundle={2}B" -f $base.graph.rev, $baseEntry.rev, $baseBundle.bytes)

    # --- phase 1: client half edited, NO restart ----------------------------
    $newMarker = 'HELLO P0B V2'
    if ($clientOrig -notmatch 'HELLO P0B') { throw 'client.js does not contain the expected marker HELLO P0B' }
    Write-Utf8NoBom $clientJs ($clientOrig.Replace('HELLO P0B', $newMarker))
    $clientEditAt = (Get-Date).ToString('o')
    Write-Host ("phase1: client.js edited at {0}, waiting {1}s" -f $clientEditAt, $WaitSeconds)
    Start-Sleep -Seconds $WaitSeconds
    $graphNoRestart = Get-DshBootGraph -ServerUrl $state.url -JarFile $jar -Tag ("{0}.after-client-edit-no-restart" -f $Tag)
    $entryNoRestart = @($graphNoRestart.graph.entries) | Where-Object { $_.id -eq $script:HelloPackage } | Select-Object -First 1
    $newUrlFetch = $null
    if ($null -ne $entryNoRestart) {
        $newUrlFetch = Get-BundleFetch -ServerUrl $state.url -JarFile $jar -RelativeUrl $entryNoRestart.url
        $newBundlePath = Join-Path $script:ArtifactDir ("{0}.after-edit.entry-bundle.js" -f $Tag)
        if ($newUrlFetch.bodyPath -ne $newBundlePath) { Move-Item $newUrlFetch.bodyPath $newBundlePath -Force -ErrorAction SilentlyContinue }
    }
    $oldUrlFetch = Get-BundleFetch -ServerUrl $state.url -JarFile $jar -RelativeUrl $baseEntry.url
    $result.phases.clientEditNoRestart = [ordered]@{
        editedAt           = $clientEditAt
        clientFileAfter    = Get-FileFingerprint $clientJs
        graphRevBefore     = $base.graph.rev
        graphRevAfter      = $graphNoRestart.graph.rev
        graphRevChanged    = ($graphNoRestart.graph.rev -ne $base.graph.rev)
        entryRevBefore     = $baseEntry.rev
        entryRevAfter      = $(if ($entryNoRestart) { $entryNoRestart.rev } else { $null })
        entryRevChanged    = ($null -ne $entryNoRestart) -and ($entryNoRestart.rev -ne $baseEntry.rev)
        newUrl             = $(if ($entryNoRestart) { $entryNoRestart.url } else { $null })
        newUrlStatus       = $(if ($newUrlFetch) { $newUrlFetch.status } else { $null })
        newUrlBytes        = $(if ($newUrlFetch) { $newUrlFetch.bytes } else { $null })
        newUrlHasV2Marker  = $(if ($newUrlFetch) { $newUrlFetch.text.Contains($newMarker) } else { $false })
        oldUrlStatusAfterRebuild = $oldUrlFetch.status
        oldUrlBytesAfterRebuild  = $oldUrlFetch.bytes
        serverStdoutAfterWait = (Get-ServerStdoutTail $state.outLog 80)
    }
    Write-Host ("phase1: graphRevChanged={0} entryRevChanged={1} newUrlStatus={2} newUrlHasV2={3} oldUrlStatus={4}" -f `
        $result.phases.clientEditNoRestart.graphRevChanged, $result.phases.clientEditNoRestart.entryRevChanged, `
        $result.phases.clientEditNoRestart.newUrlStatus, $result.phases.clientEditNoRestart.newUrlHasV2Marker, `
        $result.phases.clientEditNoRestart.oldUrlStatusAfterRebuild)

    # --- phase 2: host half edited, NO restart ------------------------------
    $newHostLine = '[hello] host applied (hot edit)'
    Write-Utf8NoBom $hostJs ($hostOrig.Replace('[hello] host applied', $newHostLine))
    $hostEditAt = (Get-Date).ToString('o')
    Write-Host ("phase2: index.js edited at {0}, waiting {1}s" -f $hostEditAt, $WaitSeconds)
    Start-Sleep -Seconds $WaitSeconds
    $stdoutAfterHostEdit = Get-ServerStdoutTail $state.outLog 200
    $procAlive = @(Get-DshServerProcesses $ProfileName)
    $result.phases.hostEditNoRestart = [ordered]@{
        editedAt         = $hostEditAt
        hostFileAfter    = Get-FileFingerprint $hostJs
        processAlive     = ($procAlive.Count -gt 0)
        hostDisposeLogged = $stdoutAfterHostEdit.Contains('[hello] host disposed')
        newHostLineLogged = $stdoutAfterHostEdit.Contains($newHostLine)
        originalLineCount = (($stdoutAfterHostEdit -split "`n") | Where-Object { $_.Contains('[hello] host applied') }).Count
        serverStdoutAfterEdit = $stdoutAfterHostEdit
    }
    Write-Host ("phase2: processAlive={0} disposedLogged={1} newHostLineLogged={2}" -f `
        $result.phases.hostEditNoRestart.processAlive, $result.phases.hostEditNoRestart.hostDisposeLogged, `
        $result.phases.hostEditNoRestart.newHostLineLogged)

    # --- restore ------------------------------------------------------------
    Write-Utf8NoBom $clientJs $clientOrig
    Write-Utf8NoBom $hostJs $hostOrig
    Start-Sleep -Seconds 2
    $graphRestored = Get-DshBootGraph -ServerUrl $state.url -JarFile $jar -Tag ("{0}.after-restore" -f $Tag)
    $entryRestored = @($graphRestored.graph.entries) | Where-Object { $_.id -eq $script:HelloPackage } | Select-Object -First 1
    $restoredFetch = $null
    if ($null -ne $entryRestored) { $restoredFetch = Get-BundleFetch -ServerUrl $state.url -JarFile $jar -RelativeUrl $entryRestored.url }
    $restoredStdout = Get-ServerStdoutTail $state.outLog 200
    $result.phases.restore = [ordered]@{
        graphRev = $graphRestored.graph.rev
        entryRev = $(if ($entryRestored) { $entryRestored.rev } else { $null })
        bundleHasV1Marker = $(if ($restoredFetch) { $restoredFetch.text.Contains('HELLO P0B') -and -not $restoredFetch.text.Contains($newMarker) } else { $false })
        hostStillOriginalLine = $restoredStdout.Contains('[hello] host applied')
        hostHotLineGone = -not $restoredStdout.Contains($newHostLine)
        clientFile = Get-FileFingerprint $clientJs
        hostFile = Get-FileFingerprint $hostJs
    }
    Write-Host ("restore: entryRev={0} bundleV1={1} hostOriginalLine={2}" -f $result.phases.restore.entryRev, $result.phases.restore.bundleHasV1Marker, $result.phases.restore.hostStillOriginalLine)

    $result.ok = $true
    $result.finishedAt = (Get-Date).ToString('o')
    $path = Join-Path $script:ArtifactDir ("{0}.result.json" -f $Tag)
    ($result | ConvertTo-Json -Depth 12) | Set-Content -Path $path -Encoding UTF8
    Write-Host ("result: {0}" -f $path)
    exit 0
} catch {
    $result.ok = $false
    $result.error = $_.Exception.Message
    $result.finishedAt = (Get-Date).ToString('o')
    try { if ($clientOrig) { Write-Utf8NoBom $clientJs $clientOrig } } catch { }
    try { if ($hostOrig) { Write-Utf8NoBom $hostJs $hostOrig } } catch { }
    Initialize-ArtifactDir
    $path = Join-Path $script:ArtifactDir ("{0}.result.json" -f $Tag)
    ($result | ConvertTo-Json -Depth 12) | Set-Content -Path $path -Encoding UTF8
    Write-Error $_
    exit 1
}
