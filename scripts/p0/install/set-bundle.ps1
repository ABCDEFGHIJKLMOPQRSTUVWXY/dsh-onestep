# Add or remove a package name from the profile's dsh.profile.bundles list WITHOUT running
# pnpm (journaled, with a backup). This is the manual route the README describes, and it is
# what proves the binding: the dependency in package.json is not enough, the bundle name is
# what contributes the package's cordis.patch.yml layer.
#
# Usage: .\set-bundle.ps1 -Action remove -Tag binding-remove
#        .\set-bundle.ps1 -Action add    -Tag binding-add
[CmdletBinding()]
param(
    [ValidateSet('add', 'remove')][string]$Action = 'remove',
    [string]$ProfileName = 'onestep-p0b',
    [string]$PackageName = 'onestep-p0b-hello',
    [string]$Tag = 'bundles'
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\lib.ps1"

$result = [ordered]@{ tag = $Tag; action = $Action; profile = $ProfileName; package = $PackageName; at = (Get-Date).ToString('o') }
try {
    Assert-SafeProfile $ProfileName | Out-Null
    Initialize-ArtifactDir
    $dir = Get-ProfileDir $ProfileName
    $manifestPath = Join-Path $dir 'package.json'
    $before = Get-Content $manifestPath -Raw -Encoding UTF8
    $beforeManifest = $before | ConvertFrom-Json
    $beforeBundles = @($beforeManifest.dsh.profile.bundles)
    $backup = Copy-ProfileManifest $ProfileName ("{0}.before" -f $Tag)
    $afterBundles = Set-ProfileBundle -ProfileName $ProfileName -PackageName $PackageName -Action $Action
    $afterManifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $depPresent = $false
    if ($afterManifest.dependencies) { $depPresent = $null -ne $afterManifest.dependencies.PSObject.Properties[$PackageName] }
    $result.before = $beforeBundles
    $result.after = @($afterManifest.dsh.profile.bundles)
    $result.bundleAdded = ($beforeBundles -notcontains $PackageName) -and ($result.after -contains $PackageName)
    $result.bundleRemoved = ($beforeBundles -contains $PackageName) -and ($result.after -notcontains $PackageName)
    $result.dependencyStillInPackageJson = $depPresent
    $result.backup = $backup
    $result.manifest = $manifestPath
    Write-Host ("bundles before: {0}" -f ($beforeBundles -join ', '))
    Write-Host ("bundles after : {0}" -f (@($result.after) -join ', '))
    Write-Host ("dependency still in package.json: {0}" -f $depPresent)
    $path = Join-Path $script:ArtifactDir ("{0}.result.json" -f $Tag)
    ($result | ConvertTo-Json -Depth 8) | Set-Content -Path $path -Encoding UTF8
    Write-Host ("result: {0}" -f $path)
    exit 0
} catch {
    Write-Error $_
    exit 1
}
