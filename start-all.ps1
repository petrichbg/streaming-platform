param([switch]$Build)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot; $runtime = Join-Path $root 'var\run'; $logs = Join-Path $root 'var\logs'
New-Item -ItemType Directory -Force -Path $runtime, $logs | Out-Null
foreach ($file in @('.env','backend\.env','web\.env.local')) { if (-not (Test-Path (Join-Path $root $file))) { throw "Missing $file. Run install-windows.cmd first." } }
if (Test-Path (Join-Path $root 'scripts\stop-production.ps1')) { & (Join-Path $root 'scripts\stop-production.ps1') }
& docker compose --project-directory $root up -d postgres redis traefik
if ($LASTEXITCODE -ne 0) { throw 'Docker infrastructure failed to start.' }
Push-Location (Join-Path $root 'backend'); try { & npx.cmd prisma migrate deploy; if ($LASTEXITCODE) { throw 'Database migration failed.' }; if ($Build) { & npm.cmd run build; if ($LASTEXITCODE) { throw 'Backend build failed.' } } } finally { Pop-Location }
if ($Build) { Push-Location (Join-Path $root 'web'); try { & npm.cmd run build; if ($LASTEXITCODE) { throw 'Web build failed.' } } finally { Pop-Location } }
$pidFile = Join-Path $runtime 'app-pids.json'
if (Test-Path $pidFile) { & (Join-Path $root 'stop-all.ps1') -KeepInfrastructure }
$node = (Get-Command node.exe -ErrorAction Stop).Source; $apps = @{}
$apps.backend = (Start-Process $node -ArgumentList @('dist/main.js') -WorkingDirectory (Join-Path $root 'backend') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'backend.stdout.log') -RedirectStandardError (Join-Path $logs 'backend.stderr.log') -PassThru).Id
$apps.web = (Start-Process $node -ArgumentList @('node_modules/next/dist/bin/next','start','-p','3001') -WorkingDirectory (Join-Path $root 'web') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'web.stdout.log') -RedirectStandardError (Join-Path $logs 'web.stderr.log') -PassThru).Id
$cloudflared = Get-Command cloudflared.exe -ErrorAction SilentlyContinue; $config = Join-Path $root 'cloudflared\streaming-platform.yml'; $credentials = Join-Path $root 'var\cloudflared\credentials.json'
if ($cloudflared -and (Test-Path $config) -and (Test-Path $credentials)) { $apps.cloudflared = (Start-Process $cloudflared.Source -ArgumentList @('tunnel','--config',$config,'--credentials-file',$credentials,'run') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'cloudflared.stdout.log') -RedirectStandardError (Join-Path $logs 'cloudflared.stderr.log') -PassThru).Id }
$apps | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8
Start-Sleep -Seconds 3; Write-Host "Started: API http://localhost:3000 | Web http://localhost:3001"; Write-Host "Logs: $logs"
