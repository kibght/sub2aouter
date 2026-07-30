param(
  [switch]$NoBrowser,
  [switch]$PrepareOnly,
  [switch]$SkipPrerequisiteInstall,
  [string]$EnvironmentFile
)

$ErrorActionPreference = 'Stop'
$runtimeRoot = $PSScriptRoot
$composeFile = Join-Path $runtimeRoot 'docker-compose.yml'
$envFile = if ($EnvironmentFile) { [IO.Path]::GetFullPath($EnvironmentFile) } else { Join-Path $runtimeRoot '.env' }
$envTemplate = Join-Path $runtimeRoot '.env.example'
$projectName = 'sub2api-windows-local'
$utf8NoBom = New-Object Text.UTF8Encoding($false)

function New-HexSecret([int]$ByteCount) {
  $bytes = New-Object byte[] $ByteCount
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
}

function Get-EnvValueFromLines([string[]]$Lines, [string]$Name) {
  $pattern = "^$([regex]::Escape($Name))="
  $line = $Lines | Where-Object { $_ -match $pattern } | Select-Object -First 1
  if ($null -eq $line) { return $null }
  return ($line -split '=', 2)[1]
}

function Set-EnvValueInLines([string[]]$Lines, [string]$Name, [string]$Value) {
  $pattern = "^$([regex]::Escape($Name))="
  $updated = New-Object System.Collections.Generic.List[string]
  $replaced = $false
  foreach ($line in $Lines) {
    if (-not $replaced -and $line -match $pattern) {
      $updated.Add("$Name=$Value")
      $replaced = $true
    } else {
      $updated.Add($line)
    }
  }
  if (-not $replaced) { $updated.Add("$Name=$Value") }
  return $updated.ToArray()
}

function Ensure-LocalEnvironment {
  if (-not (Test-Path -LiteralPath $envTemplate)) {
    throw "Environment template was not found: $envTemplate"
  }

  if (-not (Test-Path -LiteralPath $envFile)) {
    $directory = Split-Path -Parent $envFile
    if ($directory -and -not (Test-Path -LiteralPath $directory)) {
      New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $template = [IO.File]::ReadAllText($envTemplate, [Text.Encoding]::UTF8)
    $template = $template.Replace('__POSTGRES_PASSWORD__', (New-HexSecret 24))
    $template = $template.Replace('__REDIS_PASSWORD__', (New-HexSecret 24))
    $template = $template.Replace('__ADMIN_PASSWORD__', (New-HexSecret 16))
    $template = $template.Replace('__JWT_SECRET__', (New-HexSecret 32))
    $template = $template.Replace('__TOTP_ENCRYPTION_KEY__', (New-HexSecret 32))
    [IO.File]::WriteAllText($envFile, $template, $utf8NoBom)
    Write-Host "Created local environment: $envFile" -ForegroundColor Yellow
  }

  $lines = @(Get-Content -LiteralPath $envFile -Encoding UTF8)
  $changed = $false

  $defaults = [ordered]@{
    BIND_HOST = '127.0.0.1'
    SERVER_PORT = '18080'
    TZ = 'Asia/Shanghai'
    POSTGRES_USER = 'sub2api'
    POSTGRES_DB = 'sub2api'
    ADMIN_EMAIL = 'admin@local.test'
  }
  foreach ($name in $defaults.Keys) {
    if ($null -eq (Get-EnvValueFromLines $lines $name)) {
      $lines = @(Set-EnvValueInLines $lines $name $defaults[$name])
      $changed = $true
    }
  }

  $requiredSecrets = [ordered]@{
    POSTGRES_PASSWORD = 24
    ADMIN_PASSWORD = 16
    JWT_SECRET = 32
    TOTP_ENCRYPTION_KEY = 32
  }
  foreach ($name in $requiredSecrets.Keys) {
    $value = Get-EnvValueFromLines $lines $name
    if ([string]::IsNullOrWhiteSpace($value) -or $value -match '^__.+__$') {
      $lines = @(Set-EnvValueInLines $lines $name (New-HexSecret $requiredSecrets[$name]))
      $changed = $true
      Write-Host "Generated missing value for $name." -ForegroundColor Yellow
    }
  }

  $redisPassword = Get-EnvValueFromLines $lines 'REDIS_PASSWORD'
  if ($null -eq $redisPassword -or $redisPassword -match '^__.+__$') {
    $lines = @(Set-EnvValueInLines $lines 'REDIS_PASSWORD' (New-HexSecret 24))
    $changed = $true
  }
  if ($null -eq (Get-EnvValueFromLines $lines 'NPM_CONFIG_REGISTRY')) {
    $lines = @(Set-EnvValueInLines $lines 'NPM_CONFIG_REGISTRY' '')
    $changed = $true
  }

  $serverPort = Get-EnvValueFromLines $lines 'SERVER_PORT'
  $parsedPort = 0
  if (-not [int]::TryParse($serverPort, [ref]$parsedPort) -or $parsedPort -lt 1 -or $parsedPort -gt 65535) {
    throw "SERVER_PORT in $envFile must be an integer from 1 to 65535."
  }

  if ($changed) {
    [IO.File]::WriteAllLines($envFile, $lines, $utf8NoBom)
    Write-Host "Repaired local environment: $envFile" -ForegroundColor Yellow
  }
}

function Get-EnvValue([string]$Name, [string]$Default) {
  $lines = @(Get-Content -LiteralPath $envFile -Encoding UTF8)
  $value = Get-EnvValueFromLines $lines $Name
  if ($null -eq $value) { return $Default }
  return $value
}

function Find-Docker {
  $command = Get-Command docker -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $bundled = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
  if (Test-Path -LiteralPath $bundled) { return $bundled }
  return $null
}

function Resolve-Docker {
  $dockerPath = Find-Docker
  if ($dockerPath) { return $dockerPath }
  if ($SkipPrerequisiteInstall) {
    throw 'Docker Desktop is not installed.'
  }

  $installer = Join-Path $runtimeRoot 'install-prerequisites.ps1'
  if (-not (Test-Path -LiteralPath $installer)) {
    throw "Prerequisite installer was not found: $installer"
  }
  Write-Host 'Docker Desktop is missing. Starting the prerequisite installer...' -ForegroundColor Yellow
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer
  if ($LASTEXITCODE -ne 0) {
    throw "Prerequisite installation failed with exit code $LASTEXITCODE."
  }

  $dockerPath = Find-Docker
  if (-not $dockerPath) {
    throw 'Docker Desktop was installed but is not available yet. Restart Windows once, then run start-local.cmd again.'
  }
  return $dockerPath
}

function Wait-Docker([string]$DockerPath) {
  & $DockerPath info *> $null
  if ($LASTEXITCODE -eq 0) { return }
  $desktop = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
  if (Test-Path -LiteralPath $desktop) {
    Start-Process -FilePath $desktop
  }
  $deadline = (Get-Date).AddMinutes(6)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    & $DockerPath info *> $null
    if ($LASTEXITCODE -eq 0) { return }
  }
  throw 'Docker Desktop did not become ready within six minutes. Restart Windows if it was just installed.'
}

Ensure-LocalEnvironment
if ($PrepareOnly) {
  Write-Host "Local environment is ready: $envFile" -ForegroundColor Green
  return
}

$docker = Resolve-Docker
Wait-Docker $docker
& $docker compose version *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose v2 is not available.' }

Push-Location $runtimeRoot
try {
  & $docker compose --project-name $projectName --env-file $envFile -f $composeFile config --quiet
  if ($LASTEXITCODE -ne 0) { throw 'Docker Compose configuration validation failed.' }

  & $docker compose --project-name $projectName --env-file $envFile -f $composeFile up -d --build
  if ($LASTEXITCODE -ne 0) { throw 'Docker Compose startup failed.' }
} finally {
  Pop-Location
}

$serverPort = Get-EnvValue 'SERVER_PORT' '18080'
$url = "http://127.0.0.1:$serverPort/home"
$deadline = (Get-Date).AddMinutes(3)
$healthy = $false
while ((Get-Date) -lt $deadline) {
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$serverPort/health" -UseBasicParsing -TimeoutSec 3
    if ($response.StatusCode -eq 200) { $healthy = $true; break }
  } catch {}
  Start-Sleep -Seconds 2
}
if (-not $healthy) {
  & $docker compose --project-name $projectName --env-file $envFile -f $composeFile logs --tail 120 sub2api
  throw 'Sub2API did not pass its health check within three minutes.'
}

$adminEmail = Get-EnvValue 'ADMIN_EMAIL' 'admin@local.test'
$adminPassword = Get-EnvValue 'ADMIN_PASSWORD' ''
Write-Host "Full Sub2API is running: $url" -ForegroundColor Green
Write-Host "Admin email: $adminEmail"
Write-Host "Admin password: $adminPassword"
Write-Host "Data is persisted in Docker volumes under project $projectName."
if (-not $NoBrowser) { Start-Process $url }