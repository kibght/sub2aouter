$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments -Wait -PassThru
  exit $process.ExitCode
}

Write-Host 'Enabling and installing WSL2 components...' -ForegroundColor Cyan
& wsl.exe --install --no-distribution
$wslExit = $LASTEXITCODE
if ($wslExit -ne 0 -and $wslExit -ne 3010) {
  Write-Warning "WSL installer returned exit code $wslExit. Docker Desktop installation will still be attempted."
}

$dockerCli = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
if (-not (Test-Path -LiteralPath $dockerCli)) {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw 'winget is not available. Install Microsoft App Installer, then run this script again.'
  }
  Write-Host 'Installing Docker Desktop...' -ForegroundColor Cyan
  & $winget.Source install --exact --id Docker.DockerDesktop --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity
  $dockerInstallExit = $LASTEXITCODE
  if ($dockerInstallExit -ne 0 -and $dockerInstallExit -ne 3010) {
    throw "Docker Desktop installation failed with exit code $dockerInstallExit."
  }
} else {
  Write-Host 'Docker Desktop is already installed.' -ForegroundColor Green
}

Write-Host 'Prerequisites installed.' -ForegroundColor Green
Write-Host 'If Windows requests a restart, restart once and then run start-local.cmd.' -ForegroundColor Yellow