param(
  [string]$TaskName = 'StreamingPlatformProduction'
)

$processes = @(Get-CimInstance Win32_Process)
$targetIds = [Collections.Generic.HashSet[uint32]]::new()
$processes | Where-Object { $_.CommandLine -like '*production-supervisor.ps1*' } |
  ForEach-Object { [void]$targetIds.Add($_.ProcessId) }
do {
  $count = $targetIds.Count
  $processes | Where-Object { $targetIds.Contains($_.ParentProcessId) } |
    ForEach-Object { [void]$targetIds.Add($_.ProcessId) }
} while ($targetIds.Count -gt $count)

Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue |
  Stop-ScheduledTask -ErrorAction SilentlyContinue
foreach ($target in ($processes | Where-Object { $targetIds.Contains($_.ProcessId) } |
  Sort-Object ProcessId -Descending)) {
  Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue
  Write-Output "Stopped PID $($target.ProcessId): $($target.Name)"
}
