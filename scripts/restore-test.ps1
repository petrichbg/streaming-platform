[CmdletBinding()]
param(
  [string]$BackupRoot = 'G:\My Drive\StreamingPlatformBackups',
  [string]$KeyPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'var\backup-recovery.key'),
  [string]$ArchivePath
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$toolPath = Join-Path $projectRoot 'var\tools\7zr.exe'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) "streaming-restore-test-$([guid]::NewGuid())"
$containerName = "streaming-restore-test-$([guid]::NewGuid().ToString('N').Substring(0, 10))"
$testPassword = [guid]::NewGuid().ToString('N')

if (-not $ArchivePath) {
  $ArchivePath = (Get-ChildItem -LiteralPath $BackupRoot -Filter 'streaming-backup-*.7z' -File |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
}
if (-not $ArchivePath -or -not (Test-Path -LiteralPath $ArchivePath)) { throw 'No backup archive was found.' }
if ((Get-FileHash -LiteralPath $toolPath -Algorithm SHA256).Hash -ne '56B8CC9F4971CEF253644FAFE54063ED7FDCA551D4DEE0F8C6BAA81B855ACD72') {
  throw '7zr.exe checksum does not match the approved 7-Zip 26.02 standalone binary.'
}
$backupKey = [IO.File]::ReadAllText($KeyPath).Trim()
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null

try {
  & $toolPath x -y "-p$backupKey" "-o$testRoot" $ArchivePath | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Backup decryption/extraction failed.' }
  $manifestPath = Join-Path $testRoot 'manifest.json'
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  foreach ($entry in $manifest.files) {
    $filePath = Join-Path $testRoot ($entry.path.Replace('/', '\'))
    if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) { throw "Manifest file missing: $($entry.path)" }
    $hash = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $entry.sha256 -or (Get-Item -LiteralPath $filePath).Length -ne $entry.bytes) {
      throw "Manifest verification failed: $($entry.path)"
    }
  }

  & docker run -d --name $containerName -e "POSTGRES_PASSWORD=$testPassword" -e POSTGRES_DB=restore_test postgres:16-alpine | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Restore-test container failed to start.' }
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    & docker exec $containerName pg_isready -U postgres -d restore_test 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw 'Restore-test Postgres did not become ready.' }
  $dumpPath = Join-Path $testRoot 'database\streaming.dump'
  & docker cp $dumpPath "${containerName}:/tmp/streaming.dump" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not copy dump into restore-test container.' }
  & docker exec $containerName pg_restore -U postgres -d restore_test --no-owner --no-privileges /tmp/streaming.dump | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'pg_restore failed.' }
  $tableCount = (& docker exec $containerName psql -U postgres -d restore_test -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';").Trim()
  if ([int]$tableCount -lt 9) { throw "Restored schema has only $tableCount public tables." }
  [ordered]@{
    result = 'PASS'
    archive = $ArchivePath
    manifestFiles = $manifest.files.Count
    restoredPublicTables = [int]$tableCount
    testedAt = (Get-Date).ToString('o')
  } | ConvertTo-Json -Compress
} finally {
  & docker rm -f $containerName 2>$null | Out-Null
  if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
