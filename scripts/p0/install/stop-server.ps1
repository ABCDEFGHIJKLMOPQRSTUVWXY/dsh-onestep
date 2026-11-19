# Stop only the profile server of the isolated onestep-p0b profile.
# The matcher (lib.ps1 Get-DshServerProcesses) requires:
#   * process name "DeepSeek Harness.exe"
#   * command line "--expose-internals "<...>cli.js" onestep-p0b ..."
#   * NOT a subprocess-local tool runner, NOT an Electron child (--type=)
# Usage: .\stop-server.ps1 [-ProfileName onestep-p0b]
[CmdletBinding()]
param([string]$ProfileName = 'onestep-p0b')
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\lib.ps1"

try {
    Assert-SafeProfile $ProfileName | Out-Null
    $before = @(Get-DshServerProcesses $ProfileName)
    Write-Host ("matching servers before: {0}" -f $before.Count)
    foreach ($p in $before) { Write-Host ("  pid {0}: {1}" -f $p.ProcessId, $p.CommandLine) }
    $r = Stop-DshServer -ProfileName $ProfileName
    Write-Host ("stopped pids: {0}" -f (($r.stoppedPids | ForEach-Object { $_ }) -join ','))
    Write-Host ("remaining   : {0}" -f $r.remaining)
    if ($r.remaining -ne 0) { exit 1 }
    exit 0
} catch {
    Write-Error $_
    exit 1
}
