param([Parameter(Mandatory=$true)][string]$NodePath, [Parameter(Mandatory=$true)][string]$GhPath)
$ErrorActionPreference = 'Stop'
$env:SUB2_SYNC_GH = $GhPath
& $NodePath (Join-Path $PSScriptRoot 'run-sync.mjs')
exit $LASTEXITCODE
