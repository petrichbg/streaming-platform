param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
$rootEnvPath = Join-Path $ProjectRoot '.env'
$backendEnvPath = Join-Path $ProjectRoot 'backend\.env'

function Read-EnvFile([string]$Path) {
  $values = @{}
  foreach ($line in [IO.File]::ReadAllLines($Path)) {
    if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
      $values[$Matches[1]] = $Matches[2]
    }
  }
  return $values
}

function Set-EnvValue([string]$Content, [string]$Name, [string]$Value) {
  $escapedName = [Regex]::Escape($Name)
  if ($Content -match "(?m)^$escapedName=") {
    return [Regex]::Replace($Content, "(?m)^$escapedName=.*$", "$Name=$Value")
  }
  return $Content.TrimEnd() + [Environment]::NewLine + "$Name=$Value" + [Environment]::NewLine
}

function New-Secret([int]$Length = 48) {
  $alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  $bytes = [byte[]]::new($Length)
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
}

$rootOriginal = [IO.File]::ReadAllText($rootEnvPath)
$backendOriginal = [IO.File]::ReadAllText($backendEnvPath)
$rootEnv = Read-EnvFile $rootEnvPath
$backendEnv = Read-EnvFile $backendEnvPath

$postgresUser = $rootEnv.POSTGRES_USER
$postgresDb = $rootEnv.POSTGRES_DB
$oldPostgresPassword = $rootEnv.POSTGRES_PASSWORD
$oldRedisPassword = $rootEnv.REDIS_PASSWORD
if ($postgresUser -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw 'Unsafe POSTGRES_USER value.' }
foreach ($required in @($postgresDb, $oldPostgresPassword, $oldRedisPassword, $backendEnv.DATABASE_URL, $backendEnv.REDIS_URL)) {
  if ([string]::IsNullOrWhiteSpace($required)) { throw 'A required environment value is missing.' }
}

$newPostgresPassword = New-Secret
$newRedisPassword = New-Secret
$postgresChanged = $false
$redisChanged = $false

try {
  $sql = "ALTER USER `"$postgresUser`" WITH PASSWORD '$newPostgresPassword';"
  & docker exec -e "PGPASSWORD=$oldPostgresPassword" streaming-postgres `
    psql -v ON_ERROR_STOP=1 -U $postgresUser -d $postgresDb -c $sql | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Postgres password rotation failed.' }
  $postgresChanged = $true

  & docker exec streaming-redis redis-cli --no-auth-warning -a $oldRedisPassword `
    CONFIG SET requirepass $newRedisPassword | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Redis password rotation failed.' }
  $redisChanged = $true

  $databaseUrl = [Regex]::Replace(
    $backendEnv.DATABASE_URL,
    '^(postgres(?:ql)?://[^:]+:)[^@]+(@.*)$',
    "`${1}$newPostgresPassword`${2}"
  )
  $redisUrl = [Regex]::Replace(
    $backendEnv.REDIS_URL,
    '^(redis://(?:(?:[^:]+)?:))[^@]+(@.*)$',
    "`${1}$newRedisPassword`${2}"
  )
  if ($databaseUrl -eq $backendEnv.DATABASE_URL) { throw 'DATABASE_URL format is unsupported.' }
  if ($redisUrl -eq $backendEnv.REDIS_URL) { throw 'REDIS_URL format is unsupported.' }

  $rootUpdated = Set-EnvValue $rootOriginal 'POSTGRES_PASSWORD' $newPostgresPassword
  $rootUpdated = Set-EnvValue $rootUpdated 'REDIS_PASSWORD' $newRedisPassword
  $backendUpdated = Set-EnvValue $backendOriginal 'DATABASE_URL' $databaseUrl
  $backendUpdated = Set-EnvValue $backendUpdated 'REDIS_URL' $redisUrl
  [IO.File]::WriteAllText($rootEnvPath, $rootUpdated, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($backendEnvPath, $backendUpdated, [Text.UTF8Encoding]::new($false))

  & docker compose --project-directory $ProjectRoot up -d --force-recreate redis | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Redis recreation failed.' }
  Write-Output 'Postgres and Redis credentials rotated successfully.'
} catch {
  [IO.File]::WriteAllText($rootEnvPath, $rootOriginal, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($backendEnvPath, $backendOriginal, [Text.UTF8Encoding]::new($false))
  if ($redisChanged) {
    & docker exec streaming-redis redis-cli --no-auth-warning -a $newRedisPassword `
      CONFIG SET requirepass $oldRedisPassword | Out-Null
  }
  if ($postgresChanged) {
    $rollbackSql = "ALTER USER `"$postgresUser`" WITH PASSWORD '$oldPostgresPassword';"
    & docker exec -e "PGPASSWORD=$newPostgresPassword" streaming-postgres `
      psql -v ON_ERROR_STOP=1 -U $postgresUser -d $postgresDb -c $rollbackSql | Out-Null
  }
  throw
}
