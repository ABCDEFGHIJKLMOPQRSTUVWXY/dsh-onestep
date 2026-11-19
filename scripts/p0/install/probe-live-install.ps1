# Probe whether a package operation performed by the CLI while the profile server is
# RUNNING is applied live (HMR recompose) or needs a restart.
# The script never starts or stops the server; it runs `dsh plugin --profile <p> <action> <pkg>`
# and then watches the boot graph / server stdout for the change.
#
# Usage:
#   .\probe-live-install.ps1 -Action remove -Tag live-remove
#   .\probe-live-install.ps1 -Action add   -Tag live-add  -PluginPath <abs path>
[CmdletBinding()]
param(
    [ValidateSet('add', 'remove')][string]$Action = 'remove',
    [string]$ProfileName = 'onestep-p0b',
    [string]$Tag = 'live',
    [string]$PluginPath = (Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))) 'tmp\p0b-hello-plugin'),
    [string]$PackageName = 'onestep-p0b-hello',
    [int]$WaitSeconds = 12
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\lib.ps1"

$result = [ordered]@{ tag = $Tag; action = $Action; startedAt = (Get-Date).ToString('o'); ok = $false }
try {
    Assert-SafeProfile $ProfileName | Out-Null
    Initialize-ArtifactDir
    $state = Read-DshServerState $ProfileName
    if ($null -eq $state) { throw 'no server state; start the server first' }
    if (@(Get-DshServerProcesses $ProfileName).Count -eq 0) { throw "profile server is not running (state pid $($state.pid))" }
    $jar = Join-Path $script:ArtifactDir ("cookies-{0}.txt" -f $Tag)
    Connect-DshBrowserSession -ServerUrl $state.url -JarFile $jar | Out-Null

    $before = Get-DshBootGraph -ServerUrl $state.url -JarFile $jar -Tag ("{0}.before" -f $Tag)
    $beforeEntry = @($before.graph.entries) | Where-Object { $_.id -eq $PackageName } | Select-Object -First 1
    $stdoutBefore = Get-Content $state.outLog -Raw -Encoding UTF8
    $result.before = [ordered]@{
        runningPid = $state.pid; serverUrl = $state.url
        graphRev = $before.graph.rev; entryCount = @($before.graph.entries).Count
        entryPresent = ($null -ne $beforeEntry)
        entryRev = $(if ($beforeEntry) { $beforeEntry.rev } else { $null })
        hostAppliedCount = ([regex]::Matches($stdoutBefore, [regex]::Escape('[hello] host applied'))).Count
        hostDisposedCount = ([regex]::Matches($stdoutBefore, [regex]::Escape('[hello] host disposed'))).Count
    }
    Write-Host ("before: action={0} entryPresent={1} graphRev={2} pid={3}" -f $Action, $result.before.entryPresent, $before.graph.rev, $state.pid)

    $logPath = Join-Path $script:ArtifactDir ("{0}.cli.log" -f $Tag)
    $cliArgs = @('plugin', '--profile', $ProfileName, $Action, $PackageName)
    if ($Action -eq 'add') { $cliArgs[$cliArgs.Count - 1] = $PluginPath }
    $out = & $script:DshCli @cliArgs 2>&1 | Tee-Object -FilePath $logPath | Out-String
    $cliExit = $LASTEXITCODE
    $result.cli = [ordered]@{ args = ($cliArgs -join ' '); exitCode = $cliExit; log = $logPath; output = $out.Trim() }
    Write-Host ("cli: exit={0}" -f $cliExit)
    if ($cliExit -ne 0) { throw "dsh plugin $Action failed with exit code $cliExit" }

    Write-Host ("waiting {0}s for a live apply (no restart)" -f $WaitSeconds)
    Start-Sleep -Seconds $WaitSeconds
    $after = Get-DshBootGraph -ServerUrl $state.url -JarFile $jar -Tag ("{0}.after" -f $Tag)
    $afterEntry = @($after.graph.entries) | Where-Object { $_.id -eq $PackageName } | Select-Object -First 1
    $stdoutAfter = Get-Content $state.outLog -Raw -Encoding UTF8
    $proc = @(Get-DshServerProcesses $ProfileName)
    $result.after = [ordered]@{
        samePid = ($proc.Count -gt 0) -and ($proc[0].ProcessId -eq $state.pid)
        graphRev = $after.graph.rev
        graphRevChanged = ($after.graph.rev -ne $before.graph.rev)
        entryCount = @($after.graph.entries).Count
        entryPresent = ($null -ne $afterEntry)
        entryRev = $(if ($afterEntry) { $afterEntry.rev } else { $null })
        hostAppliedCount = ([regex]::Matches($stdoutAfter, [regex]::Escape('[hello] host applied'))).Count
        hostDisposedCount = ([regex]::Matches($stdoutAfter, [regex]::Escape('[hello] host disposed'))).Count
        stdoutTail = (Get-ServerStdoutTail $state.outLog 120)
    }
    $appliedLive = $false
    if ($Action -eq 'add') {
        $appliedLive = $result.after.entryPresent -and (-not $result.before.entryPresent)
    } else {
        $appliedLive = (-not $result.after.entryPresent) -and $result.before.entryPresent
    }
    $result.appliedLiveWithoutRestart = $appliedLive
    Write-Host ("after: entryPresent={0} graphRev={1} revChanged={2} appliedLive={3} disposedCount={4} appliedCount={5}" -f `
        $result.after.entryPresent, $result.after.graphRev, $result.after.graphRevChanged, $appliedLive, $result.after.hostDisposedCount, $result.after.hostAppliedCount)

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
    Initialize-ArtifactDir
    $path = Join-Path $script:ArtifactDir ("{0}.result.json" -f $Tag)
    ($result | ConvertTo-Json -Depth 12) | Set-Content -Path $path -Encoding UTF8
    Write-Error $_
    exit 1
}
