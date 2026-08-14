[CmdletBinding()]
param(
  [int]$IntervalMinutes = 5,
  [int]$QueueWarning = 20,
  [int]$StuckMinutes = 180
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$runtimeRoot = Join-Path $projectRoot 'var\monitor'
$statePath = Join-Path $runtimeRoot 'state.json'
$monitorLog = Join-Path $runtimeRoot 'monitor.jsonl'
$alertLog = Join-Path $runtimeRoot 'alerts.log'
$queueProbe = Join-Path $projectRoot 'backend\scripts\monitor-status.mjs'
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
$lockPath = Join-Path $runtimeRoot 'monitor.lock'
try {
  $monitorLock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
  Write-Output 'Another monitoring pass is already running.'
  exit 0
}

function Read-RootEnv {
  $values = @{}
  foreach ($line in [IO.File]::ReadAllLines((Join-Path $projectRoot '.env'))) {
    if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { $values[$Matches[1]] = $Matches[2] }
  }
  return $values
}

function Add-Check([Collections.Generic.List[object]]$Checks, [string]$Name, [bool]$Healthy, [string]$Message) {
  $Checks.Add([pscustomobject]@{ name = $Name; healthy = $Healthy; message = $Message })
}

function Test-Http([string]$Name, [string]$Uri, [Collections.Generic.List[object]]$Checks) {
  try {
    $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 8
    Add-Check $Checks $Name ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) "HTTP $($response.StatusCode)"
  } catch { Add-Check $Checks $Name $false $_.Exception.Message }
}

function Send-Alert([string]$Title, [string]$Message, [string]$Severity, [hashtable]$Environment) {
  $line = "$(Get-Date -Format o) [$Severity] $Title - $Message"
  Add-Content -LiteralPath $alertLog -Value $line -Encoding UTF8
  try {
    $eventType = if ($Severity -eq 'RECOVERY') { 'INFORMATION' } else { 'ERROR' }
    & eventcreate.exe /L APPLICATION /T $eventType /ID 100 /SO StreamingPlatformMonitoring /D "$Title - $Message" 2>$null | Out-Null
  } catch {}
  if ($Environment.MONITOR_WEBHOOK_URL) {
    try {
      $payload = @{ text = "[$Severity] $Title - $Message"; content = "[$Severity] $Title - $Message" } | ConvertTo-Json
      Invoke-RestMethod -Uri $Environment.MONITOR_WEBHOOK_URL -Method Post -ContentType 'application/json' -Body $payload -TimeoutSec 10 | Out-Null
    } catch { Add-Content -LiteralPath $alertLog -Value "$(Get-Date -Format o) [WEBHOOK_ERROR] $($_.Exception.Message)" -Encoding UTF8 }
  }
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $notification = [Windows.Forms.NotifyIcon]::new()
    $notification.Icon = [Drawing.SystemIcons]::Warning
    $notification.BalloonTipTitle = $Title
    $notification.BalloonTipText = $Message.Substring(0, [Math]::Min(250, $Message.Length))
    $notification.Visible = $true
    $notification.ShowBalloonTip(5000)
    Start-Sleep -Seconds 5
    $notification.Dispose()
  } catch {}
}

$checks = [Collections.Generic.List[object]]::new()
$rootEnv = Read-RootEnv
$task = Get-ScheduledTask -TaskName 'StreamingPlatformProduction' -ErrorAction SilentlyContinue
Add-Check $checks 'production_task' ($task -and $task.State -eq 'Running') $(if ($task) { "Task $($task.State)" } else { 'Task missing' })
Test-Http 'web_local' 'http://127.0.0.1:3001/login' $checks
Test-Http 'api_local' 'http://127.0.0.1:3000/health' $checks
Test-Http 'web_public' 'https://petrich.live/login' $checks
Test-Http 'api_public' 'https://api.petrich.live/health' $checks

try {
  $probeJson = & node $queueProbe 2>&1
  if ($LASTEXITCODE -ne 0) { throw ($probeJson -join ' ') }
  $probe = $probeJson | ConvertFrom-Json
  Add-Check $checks 'postgres' ([bool]$probe.postgres) $(if ($probe.postgres) { 'query OK' } else { $probe.postgresError })
  Add-Check $checks 'redis' ([bool]$probe.redis) $(if ($probe.redis) { 'PING PONG' } else { $probe.redisError })
  Add-Check $checks 'transcode_backlog' ($probe.queue.queued -le $QueueWarning) "queued=$($probe.queue.queued), running=$($probe.queue.running)"
  Add-Check $checks 'transcode_stuck' ($probe.queue.oldestActiveMinutes -le $StuckMinutes) "oldestActiveMinutes=$($probe.queue.oldestActiveMinutes)"
  Add-Check $checks 'transcode_failed_24h' ($probe.queue.failed24h -eq 0) "failed24h=$($probe.queue.failed24h)"
} catch {
  Add-Check $checks 'postgres' $false "queue probe failed: $($_.Exception.Message)"
  Add-Check $checks 'redis' $false 'queue probe unavailable'
  Add-Check $checks 'transcode_queue' $false 'queue probe unavailable'
}

foreach ($disk in @(
  @{ Name = 'disk_c'; Drive = 'C'; MinGB = 25; MinPercent = 8 },
  @{ Name = 'disk_d'; Drive = 'D'; MinGB = 50; MinPercent = 10 },
  @{ Name = 'disk_backup'; Drive = 'G'; MinGB = 10; MinPercent = 5 }
)) {
  $drive = Get-PSDrive -Name $disk.Drive -PSProvider FileSystem -ErrorAction SilentlyContinue
  if (-not $drive) { Add-Check $checks $disk.Name $false "drive $($disk.Drive): unavailable"; continue }
  $total = $drive.Used + $drive.Free
  $freeGB = [Math]::Round($drive.Free / 1GB, 1)
  $freePercent = if ($total -gt 0) { [Math]::Round(100 * $drive.Free / $total, 1) } else { 0 }
  Add-Check $checks $disk.Name ($freeGB -ge $disk.MinGB -and $freePercent -ge $disk.MinPercent) "free=${freeGB}GB (${freePercent}%)"
}

$auditSince = (Get-Date).ToUniversalTime().AddMinutes(-2 * $IntervalMinutes)
$auditCounts = @{ login_failed = 0; playback_failed = 0; transcode_failed = 0 }
Get-ChildItem -LiteralPath (Join-Path $projectRoot 'var\logs') -Filter 'backend-*.std*.log' -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 8 | ForEach-Object {
    foreach ($line in (Get-Content -LiteralPath $_.FullName -Tail 500 -ErrorAction SilentlyContinue)) {
      if ($line -match '(\{"marker":"STREAMING_AUDIT".*\})') {
        try {
          $record = $Matches[1] | ConvertFrom-Json
          if ([datetime]$record.timestamp -ge $auditSince -and $auditCounts.ContainsKey([string]$record.event)) {
            $auditCounts[[string]$record.event]++
          }
        } catch {}
      }
    }
  }
Add-Check $checks 'failed_logins' ($auditCounts.login_failed -lt 5) "last$($IntervalMinutes * 2)m=$($auditCounts.login_failed)"
Add-Check $checks 'failed_playback' ($auditCounts.playback_failed -lt 3) "last$($IntervalMinutes * 2)m=$($auditCounts.playback_failed)"
Add-Check $checks 'failed_transcode_requests' ($auditCounts.transcode_failed -lt 3) "last$($IntervalMinutes * 2)m=$($auditCounts.transcode_failed)"

$previous = @{}
if (Test-Path -LiteralPath $statePath) {
  try { (Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json).checks.psobject.Properties | ForEach-Object { $previous[$_.Name] = [bool]$_.Value } } catch {}
}
$current = @{}
$alerts = [Collections.Generic.List[string]]::new()
$recoveries = [Collections.Generic.List[string]]::new()
foreach ($check in $checks) {
  $current[$check.name] = $check.healthy
  if (-not $check.healthy -and (-not $previous.ContainsKey($check.name) -or $previous[$check.name])) { $alerts.Add("$($check.name): $($check.message)") }
  if ($check.healthy -and $previous.ContainsKey($check.name) -and -not $previous[$check.name]) { $recoveries.Add("$($check.name): $($check.message)") }
}
if ($alerts.Count) { Send-Alert 'Streaming platform alert' ($alerts -join '; ') 'ERROR' $rootEnv }
if ($recoveries.Count) { Send-Alert 'Streaming platform recovered' ($recoveries -join '; ') 'RECOVERY' $rootEnv }

$snapshot = [ordered]@{ timestamp = (Get-Date).ToUniversalTime().ToString('o'); healthy = -not ($checks | Where-Object { -not $_.healthy }); checks = $checks }
Add-Content -LiteralPath $monitorLog -Value ($snapshot | ConvertTo-Json -Depth 5 -Compress) -Encoding UTF8
[ordered]@{ updatedAt = $snapshot.timestamp; checks = $current } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statePath -Encoding UTF8
$snapshot | ConvertTo-Json -Depth 5
$monitorLock.Dispose()
if (-not $snapshot.healthy) { exit 2 }
exit 0
