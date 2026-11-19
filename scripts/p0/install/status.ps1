# Show the isolated profile's current state: manifest, bundle selection, server process,
# boot-graph entry for the hello package, and node_modules link.
# Usage: .\status.ps1 [-ProfileName onestep-p0b]
[CmdletBinding()]
param([string]$ProfileName = 'onestep-p0b')
$ErrorActionPreference = 'Continue'
. "$PSScriptRoot\lib.ps1"

Assert-SafeProfile $ProfileName | Out-Null
$profileDir = Get-ProfileDir $ProfileName
Write-Host ('== profile ==')
Write-Host ('dir       : {0}' -f $profileDir)
Write-Host ('manifest  : {0}' -f (Test-Path (Join-Path $profileDir 'package.json')))
$manifest = Get-ProfileManifest $ProfileName
if ($manifest) {
    $deps = @()
    if ($manifest.dependencies) { $manifest.dependencies.PSObject.Properties | ForEach-Object { $deps += ('{0}={1}' -f $_.Name, $_.Value) } }
    Write-Host ('deps      : {0}' -f (($deps -join '; ')))
    Write-Host ('bundles   : {0}' -f ((@($manifest.dsh.profile.bundles)) -join ', '))
}
$helloDir = Join-Path (Join-Path $profileDir 'node_modules') $script:HelloPackage
if (Test-Path $helloDir) {
    $item = Get-Item $helloDir -Force
    Write-Host ('node_modules link : {0} -> {1}' -f $item.LinkType, ($item.Target -join ','))
} else {
    Write-Host 'node_modules link : absent'
}

Write-Host ''
Write-Host ('== server processes (profile {0}) ==' -f $ProfileName)
$procs = @(Get-DshServerProcesses $ProfileName)
if ($procs.Count -eq 0) {
    Write-Host 'none'
} else {
    foreach ($p in $procs) { Write-Host ('pid {0}: {1}' -f $p.ProcessId, $p.CommandLine) }
}
$state = Read-DshServerState $ProfileName
if ($state) {
    Write-Host ('state     : {0}' -f (Get-StatePath $ProfileName))
    Write-Host ('last pid  : {0}' -f $state.pid)
    Write-Host ('last url  : {0}' -f $state.url)
    $procAlive = $null -ne (Get-Process -Id $state.pid -ErrorAction SilentlyContinue)
    Write-Host ('pid alive : {0}' -f $procAlive)
    if ($procAlive) {
        Write-Host ''
        Write-Host '== boot graph (live HTTP) =='
        $jar = Join-Path $script:ArtifactDir 'cookies-status.txt'
        Connect-DshBrowserSession -ServerUrl $state.url -JarFile $jar | Out-Null
        try {
            $boot = Get-DshBootGraph -ServerUrl $state.url -JarFile $jar -Tag 'status'
            Write-Host ('graph rev : {0}' -f $boot.graph.rev)
            Write-Host ('entries   : {0}' -f @($boot.graph.entries).Count)
            $hit = @($boot.graph.entries) | Where-Object { $_.id -eq $script:HelloPackage }
            if ($hit) {
                Write-Host ('hello     : present rev={0} url={1}' -f $hit[0].rev, $hit[0].url)
            } else {
                Write-Host 'hello     : absent'
            }
        } catch {
            Write-Host ('boot graph: ERROR ' + $_.Exception.Message)
        }
    }
}
