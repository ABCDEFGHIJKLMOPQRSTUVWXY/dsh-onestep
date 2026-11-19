# P2-7 release rehearsal: run `dsh plugin --profile onestep-p2 <action> <target>` with evidence capture.
# ASCII only (Windows PowerShell 5.1 reads UTF-8 .ps1 as ANSI without BOM).
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/p2/pack/plugin.ps1 -Action add -Target "D:\...\dsh-onestep-0.1.0-p1.0.tgz" -Tag r3-add
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/p2/pack/plugin.ps1 -Action remove -Target dsh-onestep -Tag r5-remove
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/p2/pack/plugin.ps1 -Action list -Tag list
param(
    [Parameter(Mandatory = $true)][ValidateSet('add', 'remove', 'list')][string]$Action,
    [string]$Target = 'dsh-onestep',
    [string]$Tag = 'plugin'
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\lib.ps1"

try {
    if ($Action -eq 'list') {
        $r = Invoke-DshPlugin -DshArgs @('list') -Tag $Tag
    } else {
        $r = Invoke-DshPlugin -DshArgs @($Action, $Target) -Tag $Tag
    }
    $out = [ordered]@{ ok = ($r.exitCode -eq 0); action = $Action; target = $Target; exitCode = $r.exitCode; log = $r.log; output = $r.output }
    Write-Host ('[plugin] ' + $Action + ' exit=' + $r.exitCode + ' log=' + $r.log)
    Write-Host $r.output
    Write-JsonEvidence ('plugin-' + $Tag + '.json') $out | Out-Null
    exit $r.exitCode
} catch {
    Write-Error ('[plugin] FAILED: ' + $_.Exception.Message)
    exit 1
}
