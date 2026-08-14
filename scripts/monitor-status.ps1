$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$task = Get-ScheduledTask -TaskName 'StreamingPlatformMonitoring' -ErrorAction SilentlyContinue
if ($task) {
  $info = Get-ScheduledTaskInfo -TaskName $task.TaskName
  Write-Output "Task: $($task.State); last=$($info.LastRunTime); result=$($info.LastTaskResult); next=$($info.NextRunTime)"
} else { Write-Output 'Task: not installed' }
$log = Join-Path $projectRoot 'var\monitor\monitor.jsonl'
if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Tail 1 }
$alerts = Join-Path $projectRoot 'var\monitor\alerts.log'
if (Test-Path -LiteralPath $alerts) { Write-Output 'Recent alerts:'; Get-Content -LiteralPath $alerts -Tail 10 }
