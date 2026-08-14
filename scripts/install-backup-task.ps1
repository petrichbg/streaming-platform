param(
  [string]$TaskName = 'StreamingPlatformDailyBackup',
  [string]$BackupRoot = 'G:\My Drive\StreamingPlatformBackups',
  [string]$At = '03:00'
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$backupScript = Join-Path $PSScriptRoot 'backup.ps1'
$keyPath = Join-Path $projectRoot 'var\backup-recovery.key'
$toolPath = Join-Path $projectRoot 'var\tools\7zr.exe'
$powershellExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name

if (-not (Test-Path -LiteralPath $toolPath)) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $toolPath) | Out-Null
  Invoke-WebRequest -Uri 'https://7-zip.org/a/7zr.exe' -OutFile $toolPath -UseBasicParsing -TimeoutSec 60
}
if ((Get-FileHash -LiteralPath $toolPath -Algorithm SHA256).Hash -ne '56B8CC9F4971CEF253644FAFE54063ED7FDCA551D4DEE0F8C6BAA81B855ACD72') {
  throw 'Downloaded 7zr.exe checksum does not match the approved 7-Zip 26.02 standalone binary.'
}

if (-not (Test-Path -LiteralPath $keyPath)) {
  $bytes = [byte[]]::new(48)
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  $key = [Convert]::ToBase64String($bytes)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $keyPath) | Out-Null
  [IO.File]::WriteAllText($keyPath, $key, [Text.UTF8Encoding]::new($false))
  & icacls $keyPath /inheritance:r /grant:r "$identity`:F" 'SYSTEM:F' 'Administrators:F' | Out-Null
}

$arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$backupScript`" -BackupRoot `"$BackupRoot`" -KeyPath `"$keyPath`""
$action = New-ScheduledTaskAction -Execute $powershellExe -Argument $arguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 4)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description 'Encrypted streaming-platform backup with retention' -Force | Out-Null
Write-Output "Installed daily backup task $TaskName at $At for $identity."
