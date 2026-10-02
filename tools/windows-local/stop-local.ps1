$ErrorActionPreference = 'Stop'
$runtimeRoot = $PSScriptRoot
$composeFile = Join-Path $runtimeRoot 'docker-compose.yml'
$envFile = Join-Path $runtimeRoot '.env'
$projectName = 'sub2api-windows-local'
$docker = (Get-Command docker -ErrorAction SilentlyContinue).Source
if (-not $docker) {
  $docker = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
}
if (-not (Test-Path -LiteralPath $docker)) { throw 'Docker CLI was not found.' }
Push-Location $runtimeRoot
try {
  & $docker compose --project-name $projectName --env-file $envFile -f $composeFile down
  if ($LASTEXITCODE -ne 0) { throw 'Docker Compose stop failed.' }
} finally {
  Pop-Location
}
Write-Host 'Sub2API stopped. PostgreSQL, Redis, and application data volumes were preserved.' -ForegroundColor Green