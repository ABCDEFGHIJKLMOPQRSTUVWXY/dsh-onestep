# Install the minimal hello plugin into the isolated profile through the shipped CLI,
# then restart the profile server and verify the install over HTTP.
#
# The CLI (`dsh plugin --profile <p> add <path>`) forwards to the same operations layer as
# the Plugins page: it runs pnpm in the profile directory AND reconciles the profile bundle
# list. This script records whether the bundles edit happened automatically (observed) and
# keeps an explicit fallback (`-EnsureBundle`) in case a future build stops doing it.
#
# Usage:
#   .\install-plugin.ps1 -Tag boot-2
#   .\install-plugin.ps1 -Tag boot-2 -PluginPath D:\...\tmp\p0b-hello-plugin
[CmdletBinding()]
param(
    [string]$ProfileName = 'onestep-p0b',
    [string]$PluginPath = (Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))) 'tmp\p0b-hello-plugin'),
    [string]$PackageName = 'onestep-p0b-hello',
    [string]$Tag = 'install',
    [int]$Port = 0,
    [switch]$NoRestart,
    [switch]$EnsureBundle
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\lib.ps1"

$summary = [ordered]@{
    tag = $Tag; profile = $ProfileName; pluginPath = $PluginPath; package = $PackageName
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
    if (-not (Test-Path (Join-Path $profileDir 'package.json'))) {
        throw "profile '$ProfileName' is not initialized; run start-server.ps1 once first"
    }
    if (-not (Test-Path (Join-Path $PluginPath 'package.json'))) { throw "plugin path not found: $PluginPath" }

    # 1. stop the profile server (CLI package operations assume no concurrent manager write;
    #    the lock only serializes writers, so keep the acceptance cycle deterministic).
    $running = @(Get-DshServerProcesses $ProfileName)
    $wasRunning = ($running.Count -gt 0)
    $stopResult = $null
    if ($wasRunning) { $stopResult = Stop-DshServer -ProfileName $ProfileName }
    Step 'stop-server' @{ wasRunning = $wasRunning; stopped = @($stopResult.stoppedPids); remaining = $(if ($stopResult) { $stopResult.remaining } else { 0 }) }

    # 2. manifest baseline
    $beforePath = Copy-ProfileManifest $ProfileName ("{0}.before" -f $Tag)
    $before = Get-ProfileManifest $ProfileName
    $beforeBundles = @($before.dsh.profile.bundles)
    Step 'manifest-before' @{ path = $beforePath; dependencies = $before.dependencies; bundles = $beforeBundles }

    # 3. install through the CLI
    $logPath = Join-Path $script:ArtifactDir ("{0}.add.log" -f $Tag)
    $out = & $script:DshCli plugin --profile $ProfileName add $PluginPath 2>&1 | Tee-Object -FilePath $logPath | Out-String
    $cliExit = $LASTEXITCODE
    Step 'cli-add' @{ exitCode = $cliExit; log = $logPath; output = $out.Trim() }
    if ($cliExit -ne 0) { throw "dsh plugin add failed with exit code $cliExit" }

    # 4. manifest after: pnpm dependency + bundle list reconciliation
    $afterPath = Copy-ProfileManifest $ProfileName ("{0}.after" -f $Tag)
    $after = Get-ProfileManifest $ProfileName
    $afterBundles = @($after.dsh.profile.bundles)
    $bundleAutoAdded = ($afterBundles -contains $PackageName) -and ($beforeBundles -notcontains $PackageName)
    $depSpec = $null
    if ($after.dependencies) {
        $depProp = $after.dependencies.PSObject.Properties[$PackageName]
        if ($depProp) { $depSpec = [string]$depProp.Value }
    }
    Step 'manifest-after' @{
        path = $afterPath; dependency = $depSpec; bundles = $afterBundles
        bundleAutoAdded = $bundleAutoAdded; installed = ($depSpec -ne $null)
    }

    # 5. explicit fallback only when the CLI did not reconcile the bundle list
    if (($afterBundles -notcontains $PackageName) -and $EnsureBundle) {
        $newBundles = Set-ProfileBundle -ProfileName $ProfileName -PackageName $PackageName -Action add -BackupTag ("{0}.before-manual-bundle" -f $Tag)
        Step 'bundle-manual-add' @{ bundles = $newBundles }
    } elseif ($afterBundles -notcontains $PackageName) {
        throw "package installed but '$PackageName' is not in dsh.profile.bundles (rerun with -EnsureBundle to write it manually)"
    }

    # 6. landing point + profile tree
    $tree = Get-ProfileTreeSnapshot -ProfileName $ProfileName -Tag ("{0}.after" -f $Tag)
    $helloDir = Join-Path (Join-Path $profileDir 'node_modules') $PackageName
    $landing = 'absent'
    if (Test-Path $helloDir) {
        $item = Get-Item $helloDir -Force
        if ($item.LinkType) { $landing = 'link (' + $item.LinkType + ') -> ' + ($item.Target -join ',') } else { $landing = 'copied directory' }
    }
    Step 'landing' @{ nodeModulesEntry = $landing; profileDir = $profileDir; treeSnapshot = $tree.path }

    if (-not $NoRestart) {
        # 7. restart and verify
        $bootTag = 'boot-' + $Tag
        $state = Start-DshServer -ProfileName $ProfileName -Port $Port -Tag $bootTag
        Step 'start-server' @{ pid = $state.pid; url = $state.url; stdout = $state.outLog; stderr = $state.errLog }
        $verifyOut = & (Join-Path $PSScriptRoot 'verify-boot.ps1') -ProfileName $ProfileName -Tag $bootTag 2>&1 | Out-String
        $verifyExit = $LASTEXITCODE
        Step 'verify' @{ exitCode = $verifyExit; output = $verifyOut.Trim() }
        if ($verifyExit -ne 0) { throw 'post-install HTTP verification failed' }
    }

    # 8. Host-half evidence is asserted inside verify-boot.ps1 (it reads the profile
    #    server's stdout in-memory). It is intentionally NOT copied into this summary:
    #    Windows PowerShell 5.1 ConvertTo-Json was observed to hang on a hashtable that
    #    carried the server's stdout text, so raw server output stays out of JSON here.
    $summary.verifyResultJson = Join-Path $script:ArtifactDir ("verify-{0}.json" -f ('boot-' + $Tag))

    $summary.ok = $true
    $summary.finishedAt = (Get-Date).ToString('o')
    $summaryPath = Join-Path $script:ArtifactDir ("{0}.summary.json" -f $Tag)
    ($summary | ConvertTo-Json -Depth 12) | Set-Content -Path $summaryPath -Encoding UTF8
    Write-Host ("summary: {0}" -f $summaryPath)
    Write-Host 'INSTALL PASS'
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
