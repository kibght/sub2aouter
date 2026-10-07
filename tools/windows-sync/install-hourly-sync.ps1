[CmdletBinding()]
param([string]$TaskName = 'Sub2Aouter-HourlySync')
$ErrorActionPreference = 'Stop'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$ghPath = (Get-Command gh.exe -ErrorAction Stop).Source
$runnerPath = Join-Path $PSScriptRoot 'run-sync.ps1'
if (-not (Test-Path -LiteralPath $runnerPath)) { throw 'Synchronization runner is missing.' }
$taskStart = (Get-Date).Date.AddHours((Get-Date).Hour).AddMinutes(37)
if ($taskStart -le (Get-Date)) { $taskStart = $taskStart.AddHours(1) }
$trigger = New-ScheduledTaskTrigger -Once -At $taskStart -RepetitionInterval (New-TimeSpan -Hours 1)
$quote = [string][char]34
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File ' + $quote + $runnerPath + $quote + ' -NodePath ' + $quote + $nodePath + $quote + ' -GhPath ' + $quote + $ghPath + $quote
$action = New-ScheduledTaskAction -Execute (Get-Command powershell.exe -ErrorAction Stop).Source -Argument $arguments -WorkingDirectory $PSScriptRoot
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$existing = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($existing) {
  Export-ScheduledTask -TaskName $TaskName -TaskPath '\' | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'previous-task.xml') -Encoding UTF8
}
Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Hourly repository synchronization fallback at minute 37; skips active or completed hourly checks and records JSONL evidence.' -Force | Out-Null
Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath '\' | Select-Object TaskName,NextRunTime,LastTaskResult
