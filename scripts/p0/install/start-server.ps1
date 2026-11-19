# Start the isolated P0-B profile server in the background and record its URL/token.
# Usage:
#   .\start-server.ps1 -Tag boot-2
#   .\start-server.ps1 -Tag boot-1 -Recreate -FromDefaultProfile web   # first creation only
# Prints the URL and the state file path; exits 1 on failure.
[CmdletBinding()]
param(
    [string]$ProfileName = 'onestep-p0b',
    [int]$Port = 0,
    [string]$Tag = 'boot',
    [int]$TimeoutSec = 180,
    [switch]$Recreate,
    [string]$FromDefaultProfile = 'web'
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\lib.ps1"

try {
    Assert-SafeProfile $ProfileName | Out-Null
    $profileDir = Get-ProfileDir $ProfileName
    $created = $false
    if (-not (Test-Path (Join-Path $profileDir 'package.json'))) {
        if (-not $Recreate) {
            $Recreate = $true
            Write-Host "profile '$ProfileName' does not exist yet; creating it from shipped template '$FromDefaultProfile'"
        }
        $created = $true
    }
    $state = Start-DshServer -ProfileName $ProfileName -Port $Port -Tag $Tag -TimeoutSec $TimeoutSec -FromDefaultProfile $FromDefaultProfile -Recreate:$Recreate
    Write-Host ("profile        : {0}" -f $ProfileName)
    Write-Host ("profileDir     : {0}" -f $profileDir)
    Write-Host ("createdProfile : {0}" -f $created)
    Write-Host ("pid            : {0}" -f $state.pid)
    Write-Host ("url            : {0}" -f $state.url)
    Write-Host ("stateFile      : {0}" -f (Get-StatePath $ProfileName))
    Write-Host ("stdout         : {0}" -f $state.outLog)
    Write-Host ("stderr         : {0}" -f $state.errLog)
    exit 0
} catch {
    Write-Error $_
    exit 1
}
