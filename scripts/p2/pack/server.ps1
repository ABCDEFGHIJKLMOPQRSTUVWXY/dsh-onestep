# P2-7 release rehearsal: start / stop / status the isolated profile 'onestep-p2' (port 4661).
# ASCII only (Windows PowerShell 5.1 reads UTF-8 .ps1 as ANSI without BOM).
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/p2/pack/server.ps1 -Action start -Tag r2 -Template web
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/p2/pack/server.ps1 -Action stop
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/p2/pack/server.ps1 -Action status
param(
    [Parameter(Mandatory = $true)][ValidateSet('start', 'stop', 'status', 'snapshot')][string]$Action,
    [string]$Tag = 'boot',
    [string]$Template = '',
    [int]$Port = 4661
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\lib.ps1"

try {
    switch ($Action) {
        'start' {
            $info = Start-DshServer -Tag $Tag -Port $Port -FromDefaultProfile $Template
            $out = [ordered]@{
                ok        = $true
                profile   = $info.profile
                pid       = $info.pid
                urlMasked = (Mask-Url $info.url)
                outLog    = $info.outLog
                errLog    = $info.errLog
                recreate  = $info.recreate
                port      = $Port
            }
            Write-Host ('[server] started pid=' + $info.pid + ' ' + (Mask-Url $info.url))
            Write-Host ('[server] profile=' + $info.profile + ' logs=' + $info.outLog)
            Write-JsonEvidence ('server-start-' + $Tag + '.json') $out | Out-Null
        }
        'stop' {
            $r = Stop-DshServer
            Write-Host ('[server] stopped pids=' + ($r.stoppedPids -join ',') + ' remaining=' + $r.remaining)
            Write-JsonEvidence ('server-stop-' + $Tag + '.json') ([ordered]@{ ok = ($r.remaining -eq 0); stoppedPids = $r.stoppedPids; remaining = $r.remaining; at = (Get-Date).ToString('o') }) | Out-Null
            if ($r.remaining -ne 0) { exit 1 }
        }
        'status' {
            $procs = @(Get-DshServerProcesses $script:Profile)
            $state = Read-DshServerState
            $url = $null
            $urlFile = Join-Path $script:ArtifactDir 'server-url.txt'
            if (Test-Path $urlFile) { $url = Get-ServerMatchingUrl $urlFile }
            $out = [ordered]@{
                profile   = $script:Profile
                port      = $script:Port
                running   = ($procs.Count -gt 0)
                pids      = @($procs | ForEach-Object { $_.ProcessId })
                urlMasked = $(if ($url) { Mask-Url $url } else { $null })
                state     = $state
            }
            Write-Host ($out | ConvertTo-Json -Depth 6)
        }
        'snapshot' {
            $tag = $Tag
            Save-ProfileManifest $tag | Out-Null
            $tree = Get-ProfileTreeSnapshot $tag
            $manifest = Get-ProfileManifest
            $bundles = @()
            $deps = [ordered]@{}
            if ($null -ne $manifest) {
                if ($manifest.dsh -and $manifest.dsh.profile -and $manifest.dsh.profile.bundles) { $bundles = @($manifest.dsh.profile.bundles) }
                if ($manifest.dependencies) {
                    foreach ($p in $manifest.dependencies.PSObject.Properties) { $deps[$p.Name] = [string]$p.Value }
                }
            }
            $out = [ordered]@{ profile = $script:Profile; bundles = $bundles; dependencies = $deps; tree = $tree; at = (Get-Date).ToString('o') }
            Write-JsonEvidence ('profile-snapshot-' + $tag + '.json') $out | Out-Null
            Write-Host ('[snapshot] bundles=' + ($bundles -join ',') + ' deps=' + (($deps.Keys) -join ',') + ' tree=' + $tree)
        }
    }
    exit 0
} catch {
    Write-Error ('[server] FAILED: ' + $_.Exception.Message)
    exit 1
}
