param([switch]$KeepInfrastructure)
$ErrorActionPreference = 'Stop'; $root = $PSScriptRoot; $pidFile = Join-Path $root 'var\run\app-pids.json'
if (Test-Path $pidFile) { $saved = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json; foreach ($property in $saved.PSObject.Properties) { $process = Get-Process -Id ([int]$property.Value) -ErrorAction SilentlyContinue; if ($process) { & taskkill.exe /PID $process.Id /T /F *> $null; Write-Host "Stopped $($property.Name) (PID $($process.Id))" } }; Remove-Item -LiteralPath $pidFile -Force }
Get-ScheduledTask -TaskName 'StreamingPlatformProduction' -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue
if (-not $KeepInfrastructure) { & docker compose --project-directory $root down; if ($LASTEXITCODE) { throw 'Docker infrastructure failed to stop.' } }
Write-Host $(if ($KeepInfrastructure) { 'Applications stopped; infrastructure kept running.' } else { 'All services stopped. Persistent database volumes were preserved.' })
