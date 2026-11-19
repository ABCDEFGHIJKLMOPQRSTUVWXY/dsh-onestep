# Verify the isolated profile server's boot payload / plugin client bundle over HTTP.
# This is the browser-free acceptance check for S1: the boot graph is the authoritative
# list of client bundles a page would load, and its per-entry `url` is the exact resource
# the page fetches (a plain /plugins/<pkg>/client.js path is NOT advertised -> 404).
#
# Present mode (default):
#   .\verify-boot.ps1 -Tag boot-2 -ExpectEntry onestep-p0b-hello -ExpectText 'HELLO P0B'
# Absent mode (-AllowAbsent) is for the uninstall check:
#   .\verify-boot.ps1 -Tag boot-4 -AllowAbsent
[CmdletBinding()]
param(
    [string]$ProfileName = 'onestep-p0b',
    [string]$Tag = 'verify',
    [string]$ServerUrl = '',
    [string]$ExpectEntry = 'onestep-p0b-hello',
    [string]$ExpectText = 'HELLO P0B',
    [switch]$AllowAbsent,
    [switch]$AllowNoHostApply
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\lib.ps1"

$failures = @()
$result = [ordered]@{}
try {
    Assert-SafeProfile $ProfileName | Out-Null
    Initialize-ArtifactDir
    $state = Read-DshServerState $ProfileName
    $serverProcs = @(Get-DshServerProcesses $ProfileName)
    if ([string]::IsNullOrWhiteSpace($ServerUrl)) {
        if ($null -eq $state) { throw 'no state file; start the server first with start-server.ps1' }
        $ServerUrl = $state.url
    }
    if ($serverProcs.Count -eq 0) { $failures += 'no matching server process is running' }
    $jar = Join-Path $script:ArtifactDir ("cookies-{0}.txt" -f $Tag)
    Connect-DshBrowserSession -ServerUrl $ServerUrl -JarFile $jar | Out-Null

    $boot = Get-DshBootGraph -ServerUrl $ServerUrl -JarFile $jar -Tag $Tag
    $graph = $boot.graph
    $entries = @($graph.entries)
    $entry = $null
    foreach ($e in $entries) { if ($e.id -eq $ExpectEntry) { $entry = $e; break } }

    $result.servedAt = (Get-Date).ToString('o')
    $result.profile = $ProfileName
    $result.serverPid = $(if ($state) { $state.pid } else { $null })
    $result.serverUrl = $ServerUrl
    $result.graphRev = $graph.rev
    $result.releaseVersion = $(if ($graph.release) { $graph.release.version } else { $null })
    $result.entryCount = $entries.Count
    $result.expectEntry = $ExpectEntry
    $result.entryFound = ($null -ne $entry)
    $result.indexHtml = $boot.htmlPath

    if ($null -ne $entry) {
        $result.entry = [ordered]@{
            id         = $entry.id
            rev        = $entry.rev
            url        = $entry.url
            initialUrl = $entry.initialUrl
            inject     = @($entry.inject)
            external   = @($entry.external)
        }
        $bundle = Get-BundleFetch -ServerUrl $ServerUrl -JarFile $jar -RelativeUrl $entry.url
        $bodyPath = Join-Path $script:ArtifactDir ("{0}.entry-bundle.js" -f $Tag)
        if ($bundle.bodyPath -ne $bodyPath) { Move-Item $bundle.bodyPath $bodyPath -Force -ErrorAction SilentlyContinue }
        $result.bundle = [ordered]@{
            target         = $bundle.target
            httpStatus     = $bundle.status
            bytes          = $bundle.bytes
            savedTo        = $bodyPath
            containsMarker = $bundle.text.Contains($ExpectText)
            registersId    = $bundle.text.Contains($ExpectEntry)
        }
        if ($bundle.status -ne 200) { $failures += "entry bundle HTTP $($bundle.status) (expected 200)" }
        if (-not $bundle.text.Contains($ExpectText)) { $failures += "entry bundle does not contain marker '$ExpectText'" }
        if (-not $bundle.text.Contains($ExpectEntry)) { $failures += "entry bundle does not register id '$ExpectEntry'" }
        # Plain path is intentionally NOT advertised; record the observed status as evidence.
        $plain = Get-HttpStatus -ServerUrl $ServerUrl -JarFile $jar -PathAndQuery ("plugins/{0}/client.js" -f $ExpectEntry)
        $result.plainPluginPathStatus = $plain
        # Same bundle without the auth cookie is still served on loopback (see docs).
        $noCookie = Invoke-Curl -Target $bundle.target -Arguments @('-o', 'NUL', '-w', '%{http_code}')
        if ($noCookie.output -match '(\d{3})') { $result.bundleWithoutCookieStatus = [int]$Matches[1] }
    } else {
        if (-not $AllowAbsent) { $failures += "entry '$ExpectEntry' not present in boot graph" }
        $result.plainPluginPathStatus = Get-HttpStatus -ServerUrl $ServerUrl -JarFile $jar -PathAndQuery ("plugins/{0}/client.js" -f $ExpectEntry)
        $legacy = Get-HttpStatus -ServerUrl $ServerUrl -JarFile $jar -PathAndQuery ("plugins/??{0}/client.js&rev=stale" -f $ExpectEntry)
        $result.staleComboStatus = $legacy
        if ($AllowAbsent -and $legacy -eq 200) { $failures += 'a stale combo URL for the removed package still answers 200' }
    }

    # Host-half evidence: the profile server writes the plugin's console line to its stdout.
    $stdout = ''
    if ($null -ne $state -and (Test-Path $state.outLog)) { $stdout = Get-Content $state.outLog -Raw -Encoding UTF8 }
    $hostApplied = $stdout.Contains('[hello] host applied')
    $result.hostApplyInStdout = $hostApplied
    $result.serverStdout = $(if ($null -ne $state) { $state.outLog } else { $null })
    if ($AllowAbsent) {
        if ($hostApplied) { $failures += "stdout still contains '[hello] host applied' after uninstall" }
    } elseif (-not $hostApplied -and -not $AllowNoHostApply) {
        $failures += "stdout does not contain '[hello] host applied' (host half not loaded)"
    }

    $result.failures = @($failures)
    $result.pass = ($failures.Count -eq 0)
    $resultPath = Join-Path $script:ArtifactDir ("verify-{0}.json" -f $Tag)
    ($result | ConvertTo-Json -Depth 8) | Set-Content -Path $resultPath -Encoding UTF8
    Write-Host ("verify tag      : {0}" -f $Tag)
    Write-Host ("server url      : {0}" -f $ServerUrl)
    Write-Host ("graph rev       : {0}" -f $result.graphRev)
    Write-Host ("entries         : {0}" -f $result.entryCount)
    Write-Host ("entry present   : {0}" -f $result.entryFound)
    if ($null -ne $entry) {
        Write-Host ("entry rev       : {0}" -f $entry.rev)
        Write-Host ("entry url       : {0}" -f $entry.url)
        Write-Host ("bundle          : HTTP {0}, {1} bytes, marker={2}" -f $result.bundle.httpStatus, $result.bundle.bytes, $result.bundle.containsMarker)
        Write-Host ("plain path      : HTTP {0} (expected 404: not advertised)" -f $result.plainPluginPathStatus)
        Write-Host ("no-cookie fetch : HTTP {0}" -f $result.bundleWithoutCookieStatus)
    }
    Write-Host ("host apply line : {0}" -f $result.hostApplyInStdout)
    Write-Host ("result json     : {0}" -f $resultPath)
    if ($failures.Count -gt 0) {
        Write-Host 'FAILURES:'
        foreach ($f in $failures) { Write-Host ('  - ' + $f) }
        exit 1
    }
    Write-Host 'PASS'
    exit 0
} catch {
    Write-Error $_
    exit 1
}
