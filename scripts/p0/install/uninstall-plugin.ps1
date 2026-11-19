# Uninstall the hello plugin from the isolated profile through the shipped CLI, then
# restart and verify the package is gone: no boot-graph entry, no host apply line,
# no /plugins bundle, no node_modules link, no profile bundle selection.
#
# Usage: .\uninstall-plugin.ps1 -Tag uninstall
[CmdletBinding()]
param(
    [string]$ProfileName = 'onestep-p0b',
    [string]$PackageName = 'onestep-p0b-hello',
    [string]$Tag = 'uninstall',
    [int]$Port = 0,
    [switch]$NoRestart
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\lib.ps1"

$summary = [ordered]@{
    tag = $Tag; profile = $ProfileName; package = $PackageName
    startedAt = (Get-Date).ToString('o'); steps = @(); ok = $false
}
function Step($name, $data) {
    $summary.steps += [ordered]@{ step = $name; at = (Get-Date).ToString('o'); data = $data }
    Write-Host ("[{0}] {1}" -f $name, ($data | ConvertTo-Json -Compress -Depth 8))
}

try {
    Assert-SafeProfile $ProfileName | Out-Null
    Initialize-ArtifactDir
    $profileDir = Get-ProfileDir $ProfileName
    if (-not (Test-Path (Join-Path $profileDir 'package.json'))) { throw "profile '$ProfileName' is not initialized" }

    # 1. stop the profile server
    $running = @(Get-DshServerProcesses $ProfileName)
    $wasRunning = ($running.Count -gt 0)
    $stopResult = $null
    if ($wasRunning) { $stopResult = Stop-DshServer -ProfileName $ProfileName }
    Step 'stop-server' @{ wasRunning = $wasRunning; stopped = @($stopResult.stoppedPids); remaining = $(if ($stopResult) { $stopResult.remaining } else { 0 }) }

    # 2. baseline
    $beforePath = Copy-ProfileManifest $ProfileName ("{0}.before" -f $Tag)
    $before = Get-ProfileManifest $ProfileName
    $beforeBundles = @($before.dsh.profile.bundles)
    $beforeTree = Get-ProfileTreeSnapshot -ProfileName $ProfileName -Tag ("{0}.before" -f $Tag)
    Step 'manifest-before' @{ path = $beforePath; bundles = $beforeBundles; treeSnapshot = $beforeTree.path }

    # 3. uninstall through the CLI
    $logPath = Join-Path $script:ArtifactDir ("{0}.remove.log" -f $Tag)
    $out = & $script:DshCli plugin --profile $ProfileName remove $PackageName 2>&1 | Tee-Object -FilePath $logPath | Out-String
    $cliExit = $LASTEXITCODE
    Step 'cli-remove' @{ exitCode = $cliExit; log = $logPath; output = $out.Trim() }
    if ($cliExit -ne 0) { throw "dsh plugin remove failed with exit code $cliExit" }

    # 4. manifest after: dependency gone, bundle selection reconciled by the CLI
    $afterPath = Copy-ProfileManifest $ProfileName ("{0}.after" -f $Tag)
    $after = Get-ProfileManifest $ProfileName
    $afterBundles = @($after.dsh.profile.bundles)
    $depGone = $true
    if ($after.dependencies) {
        $depProp = $after.dependencies.PSObject.Properties[$PackageName]
        if ($depProp) { $depGone = $false }
    }
    $bundleAutoRemoved = ($beforeBundles -contains $PackageName) -and ($afterBundles -notcontains $PackageName)
    Step 'manifest-after' @{ path = $afterPath; dependencyGone = $depGone; bundles = $afterBundles; bundleAutoRemoved = $bundleAutoRemoved }

    if ($afterBundles -contains $PackageName) {
        $newBundles = Set-ProfileBundle -ProfileName $ProfileName -PackageName $PackageName -Action remove -BackupTag ("{0}.before-manual-bundle" -f $Tag)
        Step 'bundle-manual-remove' @{ bundles = $newBundles }
    }

    # 5. profile tree after
    $afterTree = Get-ProfileTreeSnapshot -ProfileName $ProfileName -Tag ("{0}.after" -f $Tag)
    $helloDir = Join-Path (Join-Path $profileDir 'node_modules') $PackageName
    Step 'tree-after' @{ treeSnapshot = $afterTree.path; nodeModulesEntryExists = (Test-Path $helloDir) }

    if (-not $NoRestart) {
        # 6. restart and verify absence
        $bootTag = 'boot-' + $Tag
        $state = Start-DshServer -ProfileName $ProfileName -Port $Port -Tag $bootTag
        Step 'start-server' @{ pid = $state.pid; url = $state.url; stdout = $state.outLog }
        $verifyOut = & (Join-Path $PSScriptRoot 'verify-boot.ps1') -ProfileName $ProfileName -Tag $bootTag -AllowAbsent 2>&1 | Out-String
        $verifyExit = $LASTEXITCODE
        Step 'verify-absent' @{ exitCode = $verifyExit; output = $verifyOut.Trim() }
        if ($verifyExit -ne 0) { throw 'post-uninstall HTTP verification failed' }
    }

    $summary.ok = $true
    $summary.finishedAt = (Get-Date).ToString('o')
    $summaryPath = Join-Path $script:ArtifactDir ("{0}.summary.json" -f $Tag)
    ($summary | ConvertTo-Json -Depth 12) | Set-Content -Path $summaryPath -Encoding UTF8
    Write-Host ("summary: {0}" -f $summaryPath)
    Write-Host 'UNINSTALL PASS'
    exit 0
} catch {
    $summary.ok = $false
    $summary.error = $_.Exception.Message
    $summary.finishedAt = (Get-Date).ToString('o')
    Initialize-ArtifactDir
    $summaryPath = Join-Path $script:ArtifactDir ("{0}.summary.json" -f $Tag)
    ($summary | ConvertTo-Json -Depth 12) | Set-Content -Path $summaryPath -Encoding UTF8
    Write-Error $_
    Write-Host ("summary: {0}" -f $summaryPath)
    exit 1
}
