$ErrorActionPreference = 'Stop'
$runtimeRoot = $PSScriptRoot
$composeFile = Join-Path $runtimeRoot 'docker-compose.yml'
$envFile = Join-Path $runtimeRoot '.env'
$projectName = 'sub2api-windows-local'
$docker = (Get-Command docker -ErrorAction SilentlyContinue).Source
if (-not $docker) { $docker = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' }
if (-not (Test-Path -LiteralPath $docker)) { throw 'Docker CLI was not found.' }
Push-Location $runtimeRoot
try {
  & $docker compose --project-name $projectName --env-file $envFile -f $composeFile ps
  & $docker compose --project-name $projectName --env-file $envFile -f $composeFile logs --tail 80 sub2api
} finally {
  Pop-Location
}