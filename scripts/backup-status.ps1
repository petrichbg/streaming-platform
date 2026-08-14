param([string]$BackupRoot = 'G:\My Drive\StreamingPlatformBackups')

$task = Get-ScheduledTask -TaskName 'StreamingPlatformDailyBackup' -ErrorAction SilentlyContinue
if ($task) {
  $info = Get-ScheduledTaskInfo -TaskName $task.TaskName
  Write-Output "Task: $($task.State); last=$($info.LastRunTime); result=$($info.LastTaskResult); next=$($info.NextRunTime)"
} else { Write-Output 'Task: not installed' }
$latest = Get-ChildItem -LiteralPath $BackupRoot -Filter 'streaming-backup-*.7z' -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($latest) {
  Write-Output "Latest: $($latest.FullName); sizeMB=$([math]::Round($latest.Length / 1MB, 2)); ageHours=$([math]::Round(((Get-Date) - $latest.LastWriteTime).TotalHours, 1))"
} else { Write-Output 'Latest: none' }
