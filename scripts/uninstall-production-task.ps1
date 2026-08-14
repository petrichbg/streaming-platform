param(
  [string]$TaskName = 'StreamingPlatformProduction'
)

$ErrorActionPreference = 'Stop'
Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue
Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false
Write-Output "Removed scheduled task: $TaskName"
