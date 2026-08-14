param(
  [string]$TaskName = 'StreamingPlatformMonitoring',
  [int]$EveryMinutes = 5
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$monitorScript = Join-Path $PSScriptRoot 'monitor.ps1'
$powershellExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$monitorScript`" -IntervalMinutes $EveryMinutes"
$action = New-ScheduledTaskAction -Execute $powershellExe -Argument $arguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 4)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description 'Streaming platform uptime, disk, queue and audit monitoring' -Force | Out-Null
Write-Output "Installed monitoring task $TaskName every $EveryMinutes minutes for $identity."
