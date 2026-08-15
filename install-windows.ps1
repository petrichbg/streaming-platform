param([switch]$SkipSystemPackages, [switch]$NoStart)
$ErrorActionPreference = 'Stop'; $root = $PSScriptRoot
function Require-Command($name, $hint) { if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "$name is required. $hint" } }
function New-RandomHex([int]$bytes) { $buffer = New-Object byte[] $bytes; $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }; return (($buffer | ForEach-Object { $_.ToString('x2') }) -join '') }
if (-not $SkipSystemPackages) { Require-Command winget.exe 'Install Microsoft App Installer, or use -SkipSystemPackages.'; foreach ($package in @('OpenJS.NodeJS.LTS','Docker.DockerDesktop')) { & winget.exe install --id $package --exact --accept-package-agreements --accept-source-agreements --silent; if ($LASTEXITCODE -notin @(0, -1978335189)) { throw "winget failed for $package (exit $LASTEXITCODE)." } } }
Require-Command node.exe 'Install Node.js 20 or newer.'; Require-Command npm.cmd 'Install Node.js 20 or newer.'; Require-Command docker.exe 'Install and start Docker Desktop.'
if ([int]((node.exe --version).TrimStart('v').Split('.')[0]) -lt 20) { throw 'Node.js 20 or newer is required.' }
& docker info *> $null; if ($LASTEXITCODE) { throw 'Docker Desktop is installed but not running.' }
if (-not (Test-Path (Join-Path $root '.env'))) { $pg=New-RandomHex 24; $redis=New-RandomHex 24; $content=(Get-Content (Join-Path $root '.env.example') -Raw).Replace('POSTGRES_PASSWORD=changeme',"POSTGRES_PASSWORD=$pg").Replace('REDIS_PASSWORD=changeme',"REDIS_PASSWORD=$redis"); Set-Content (Join-Path $root '.env') $content -Encoding UTF8 }
$rootEnv=@{}; Get-Content (Join-Path $root '.env') | Where-Object { $_ -match '^[A-Z_]+=' } | ForEach-Object { $k,$v=$_.Split('=',2); $rootEnv[$k]=$v }
if (-not (Test-Path (Join-Path $root 'backend\.env'))) { $jwt=New-RandomHex 48; $content=(Get-Content (Join-Path $root 'backend\.env.example') -Raw).Replace('streaming:changeme@localhost',"streaming:$($rootEnv.POSTGRES_PASSWORD)@localhost").Replace('redis://:changeme@localhost',"redis://:$($rootEnv.REDIS_PASSWORD)@localhost").Replace('JWT_SECRET=changeme-generate-a-real-random-secret',"JWT_SECRET=$jwt"); Set-Content (Join-Path $root 'backend\.env') $content -Encoding UTF8 }
if (-not (Test-Path (Join-Path $root 'web\.env.local'))) { Copy-Item (Join-Path $root 'web\.env.example') (Join-Path $root 'web\.env.local') }
Push-Location (Join-Path $root 'backend'); try { & npm.cmd ci; & npx.cmd prisma generate; & npm.cmd run build } finally { Pop-Location }
Push-Location (Join-Path $root 'web'); try { & npm.cmd ci; & npm.cmd run build } finally { Pop-Location }
if (-not $NoStart) { & (Join-Path $root 'start-all.ps1') }; Write-Host 'Windows installation completed.'
