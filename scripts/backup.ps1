[CmdletBinding()]
param(
  [string]$BackupRoot = 'G:\My Drive\StreamingPlatformBackups',
  [string]$KeyPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'var\backup-recovery.key'),
  [int]$DailyRetention = 14,
  [int]$WeeklyRetention = 8,
  [int]$MonthlyRetention = 12
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$archiveName = "streaming-backup-$stamp.7z"
$archivePath = Join-Path $BackupRoot $archiveName
$toolPath = Join-Path $projectRoot 'var\tools\7zr.exe'
$stagingRoot = Join-Path ([IO.Path]::GetTempPath()) "streaming-backup-$([guid]::NewGuid())"
$containerDump = '/tmp/streaming-platform-backup.dump'

function Read-EnvFile([string]$Path) {
  $values = @{}
  foreach ($line in [IO.File]::ReadAllLines($Path)) {
    if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { $values[$Matches[1]] = $Matches[2] }
  }
  return $values
}

function Copy-RequiredFile([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw "Required backup source is missing: $Source" }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Apply-Retention {
  $archives = @(Get-ChildItem -LiteralPath $BackupRoot -Filter 'streaming-backup-*.7z' -File |
    ForEach-Object {
      if ($_.BaseName -match '^streaming-backup-(\d{4}-\d{2}-\d{2})_(\d{6})$') {
        [pscustomobject]@{ File = $_; Timestamp = [datetime]::ParseExact("$($Matches[1])_$($Matches[2])", 'yyyy-MM-dd_HHmmss', $null) }
      }
    } | Sort-Object Timestamp -Descending)
  $keep = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $archives | Select-Object -First $DailyRetention | ForEach-Object { [void]$keep.Add($_.File.FullName) }
  $calendar = [Globalization.CultureInfo]::InvariantCulture.Calendar
  $archives | Group-Object { "{0}-{1:D2}" -f $_.Timestamp.Year, $calendar.GetWeekOfYear($_.Timestamp, 'FirstFourDayWeek', 'Monday') } |
    Select-Object -First $WeeklyRetention | ForEach-Object { [void]$keep.Add(($_.Group | Sort-Object Timestamp -Descending | Select-Object -First 1).File.FullName) }
  $archives | Group-Object { $_.Timestamp.ToString('yyyy-MM') } | Select-Object -First $MonthlyRetention |
    ForEach-Object { [void]$keep.Add(($_.Group | Sort-Object Timestamp -Descending | Select-Object -First 1).File.FullName) }
  foreach ($archive in $archives) {
    if (-not $keep.Contains($archive.File.FullName)) {
      Remove-Item -LiteralPath $archive.File.FullName -Force
      Write-Output "Retention removed: $($archive.File.Name)"
    }
  }
}

if (-not (Test-Path -LiteralPath $toolPath)) { throw "7zr.exe is missing: $toolPath" }
if ((Get-FileHash -LiteralPath $toolPath -Algorithm SHA256).Hash -ne '56B8CC9F4971CEF253644FAFE54063ED7FDCA551D4DEE0F8C6BAA81B855ACD72') {
  throw '7zr.exe checksum does not match the approved 7-Zip 26.02 standalone binary.'
}
if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) { throw "Backup recovery key is missing: $KeyPath" }
$backupKey = [IO.File]::ReadAllText($KeyPath).Trim()
if ($backupKey.Length -lt 32) { throw 'Backup recovery key is too short.' }

New-Item -ItemType Directory -Force -Path $BackupRoot, $stagingRoot | Out-Null
try {
  $rootEnv = Read-EnvFile (Join-Path $projectRoot '.env')
  $dbDump = Join-Path $stagingRoot 'database\streaming.dump'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dbDump) | Out-Null
  & docker exec streaming-postgres pg_dump -U $rootEnv.POSTGRES_USER -d $rootEnv.POSTGRES_DB `
    --format=custom --compress=9 --file=$containerDump
  if ($LASTEXITCODE -ne 0) { throw 'pg_dump failed.' }
  & docker cp "streaming-postgres`:$containerDump" $dbDump | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'docker cp of the database dump failed.' }
  & docker exec streaming-postgres rm -f $containerDump | Out-Null

  Copy-RequiredFile (Join-Path $projectRoot '.env') (Join-Path $stagingRoot 'config\root.env')
  Copy-RequiredFile (Join-Path $projectRoot 'backend\.env') (Join-Path $stagingRoot 'config\backend.env')
  Copy-RequiredFile (Join-Path $projectRoot 'web\.env.local') (Join-Path $stagingRoot 'config\web.env.local')
  if (Test-Path -LiteralPath (Join-Path $projectRoot 'ruvector.db')) {
    Copy-RequiredFile (Join-Path $projectRoot 'ruvector.db') (Join-Path $stagingRoot 'metadata\ruvector.db')
  }
  if (Test-Path -LiteralPath 'D:\media-posters') {
    Copy-Item -LiteralPath 'D:\media-posters' -Destination (Join-Path $stagingRoot 'posters') -Recurse -Force
  }
  if (Test-Path -LiteralPath (Join-Path $projectRoot 'traefik\certs')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot 'traefik\certs') -Destination (Join-Path $stagingRoot 'traefik-certs') -Recurse -Force
  }
  if (Test-Path -LiteralPath (Join-Path $projectRoot 'var\cloudflared\credentials.json')) {
    Copy-RequiredFile (Join-Path $projectRoot 'var\cloudflared\credentials.json') (Join-Path $stagingRoot 'cloudflared\credentials.json')
  }

  $files = @(Get-ChildItem -LiteralPath $stagingRoot -Recurse -File)
  $manifest = [ordered]@{
    formatVersion = 1
    createdAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    sourceHost = $env:COMPUTERNAME
    gitCommit = (& git -C $projectRoot rev-parse HEAD).Trim()
    retention = @{ daily = $DailyRetention; weekly = $WeeklyRetention; monthly = $MonthlyRetention }
    files = @($files | ForEach-Object {
      [ordered]@{
        path = $_.FullName.Substring($stagingRoot.Length + 1).Replace('\', '/')
        bytes = $_.Length
        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      }
    })
  }
  $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $stagingRoot 'manifest.json') -Encoding UTF8

  Push-Location $stagingRoot
  try {
    & $toolPath a -t7z -mx=7 -mhe=on "-p$backupKey" $archivePath '.\*' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Encrypted archive creation failed.' }
  } finally { Pop-Location }
  & $toolPath t "-p$backupKey" $archivePath | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Encrypted archive verification failed.' }
  Apply-Retention
  $result = [ordered]@{
    archive = $archivePath
    bytes = (Get-Item -LiteralPath $archivePath).Length
    sha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    createdAt = (Get-Date).ToString('o')
  }
  $result | ConvertTo-Json -Compress
} finally {
  & docker exec streaming-postgres rm -f $containerDump 2>$null | Out-Null
  if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
}
