<#
.SYNOPSIS
    Backs up the streaming platform: source archive, database dump, and
    the .env files that are deliberately kept out of git.

.DESCRIPTION
    Produces three artifacts per run, timestamped so runs never overwrite
    each other:

      streaming-platform-<stamp>.zip   source tree, minus node_modules/dist
      db-<stamp>.sql                   pg_dump of the Postgres database
      env-<stamp>/                     copies of .env and backend/.env

    SECURITY: the env folder and the DB dump contain real secrets
    (JWT_SECRET, database password). Keep the backup directory off any
    shared drive or cloud sync you would not trust with those.

.PARAMETER BackupRoot
    Where to write backups. Defaults to a sibling of the project folder so
    the archive never tries to include itself.

.EXAMPLE
    .\scripts\backup.ps1
    .\scripts\backup.ps1 -BackupRoot E:\backups\streaming
#>
[CmdletBinding()]
param(
    [string]$BackupRoot = "D:\AI\streaming-platform-backups"
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'

if (-not (Test-Path $BackupRoot)) {
    New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
}

Write-Host "Project:  $projectRoot"
Write-Host "Backup:   $BackupRoot"
Write-Host ""

# ---------------------------------------------------------------- source zip
# Compress-Archive has no exclude switch, so build the file list first.
# node_modules and dist are reinstallable; gpu-test/out holds ~90 disposable
# test clips. Including any of them would dominate the archive for no gain.
$excludePattern = '\\(node_modules|dist|\.git)(\\|$)|\\scripts\\gpu-test\\out\\'

$files = Get-ChildItem -Path $projectRoot -Recurse -File |
    Where-Object { $_.FullName -notmatch $excludePattern }

$zipPath = Join-Path $BackupRoot "streaming-platform-$stamp.zip"
Write-Host "Archiving $($files.Count) files..."

# Relative paths keep the archive rooted at the project, not at D:\.
Push-Location $projectRoot
try {
    $relative = $files | ForEach-Object {
        $_.FullName.Substring($projectRoot.Length + 1)
    }
    Compress-Archive -Path $relative -DestinationPath $zipPath -CompressionLevel Optimal
}
finally {
    Pop-Location
}

$zipMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
Write-Host "  OK  $zipPath ($zipMb MB)"

# ------------------------------------------------------------------- db dump
$dbPath = Join-Path $BackupRoot "db-$stamp.sql"
Write-Host "Dumping database..."

# Redirect rather than -f so the file lands on the host, not in the container.
docker exec streaming-postgres pg_dump -U streaming -d streaming |
    Out-File -FilePath $dbPath -Encoding utf8

if ($LASTEXITCODE -ne 0) {
    throw "pg_dump failed with exit code $LASTEXITCODE. Is the streaming-postgres container running?"
}

$dbKb = [math]::Round((Get-Item $dbPath).Length / 1KB, 1)
Write-Host "  OK  $dbPath ($dbKb KB)"

# --------------------------------------------------------------- env secrets
$envDir = Join-Path $BackupRoot "env-$stamp"
New-Item -ItemType Directory -Path $envDir -Force | Out-Null

$envFiles = @(
    @{ Source = Join-Path $projectRoot '.env';         Name = 'root.env' },
    @{ Source = Join-Path $projectRoot 'backend\.env'; Name = 'backend.env' }
)

foreach ($entry in $envFiles) {
    if (Test-Path $entry.Source) {
        Copy-Item $entry.Source (Join-Path $envDir $entry.Name)
        Write-Host "  OK  $($entry.Name)"
    }
    else {
        Write-Warning "  Missing: $($entry.Source)"
    }
}

Write-Host ""
Write-Host "Backup complete: $stamp"
Write-Host "NOTE: $envDir and the .sql dump contain secrets. Store accordingly."
