$task = Get-ScheduledTask -TaskName 'StreamingPlatformProduction' -ErrorAction SilentlyContinue
if ($task) { Write-Output "Task: $($task.State)" } else { Write-Output 'Task: not installed' }

$processes = @(Get-CimInstance Win32_Process)
$processIds = [Collections.Generic.HashSet[uint32]]::new()
$processes | Where-Object { $_.CommandLine -like '*production-supervisor.ps1*' } |
  ForEach-Object { [void]$processIds.Add($_.ProcessId) }
do {
  $count = $processIds.Count
  $processes | Where-Object { $processIds.Contains($_.ParentProcessId) } |
    ForEach-Object { [void]$processIds.Add($_.ProcessId) }
} while ($processIds.Count -gt $count)
$processes | Where-Object { $processIds.Contains($_.ProcessId) } |
  Select-Object ProcessId, ParentProcessId, Name, CommandLine

foreach ($check in @(
  @{ Name = 'API'; Uri = 'http://127.0.0.1:3000/health' },
  @{ Name = 'Web'; Uri = 'http://127.0.0.1:3001/login' }
)) {
  try {
    $response = Invoke-WebRequest -Uri $check.Uri -UseBasicParsing -TimeoutSec 5
    Write-Output "$($check.Name): HTTP $($response.StatusCode)"
  } catch {
    Write-Output "$($check.Name): unavailable"
  }
}
