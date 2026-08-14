param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$backendRoot = Join-Path $ProjectRoot 'backend'
$webRoot = Join-Path $ProjectRoot 'web'
$runtimeRoot = Join-Path $ProjectRoot 'var'
$logRoot = Join-Path $runtimeRoot 'logs'
$npmExe = (Get-Command npm.cmd -ErrorAction Stop).Source
$cloudflaredExe = (Get-Command cloudflared.exe -ErrorAction Stop).Source
$cloudflaredConfig = Join-Path $ProjectRoot 'cloudflared\streaming-platform.yml'
$cloudflaredCredentials = Join-Path $runtimeRoot 'cloudflared\credentials.json'
$mutex = [Threading.Mutex]::new($false, 'Global\StreamingPlatformProductionSupervisor')
$ownsMutex = $false

try {
  $ownsMutex = $mutex.WaitOne(0)
  if (-not $ownsMutex) { exit 0 }

  New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
  $supervisorLog = Join-Path $logRoot 'supervisor.log'

  function Write-SupervisorLog([string]$Message) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
    Add-Content -LiteralPath $supervisorLog -Value $line -Encoding UTF8
  }

  function Wait-ForInfrastructure {
    $attempt = 0
    while ($true) {
      $attempt++
      try {
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $dockerOutput = & docker compose --project-directory $ProjectRoot up -d postgres redis traefik 2>&1
        $dockerExitCode = $LASTEXITCODE
        $ErrorActionPreference = $previousPreference
        $dockerOutput | ForEach-Object { Write-SupervisorLog "docker: $_" }
        if ($dockerExitCode -eq 0) {
          Write-SupervisorLog 'Infrastructure is running.'
          return
        }
      } catch {
        Write-SupervisorLog "Docker is not ready: $($_.Exception.Message)"
      }
      Write-SupervisorLog "Infrastructure attempt $attempt failed; retrying in 15 seconds."
      Start-Sleep -Seconds 15
    }
  }

  function Start-AppProcess {
    param(
      [string]$Name,
      [string]$FilePath,
      [string]$WorkingDirectory,
      [string[]]$Arguments
    )
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $stdout = Join-Path $logRoot "$Name-$stamp.stdout.log"
    $stderr = Join-Path $logRoot "$Name-$stamp.stderr.log"
    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments `
      -WorkingDirectory $WorkingDirectory -WindowStyle Hidden `
      -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    Write-SupervisorLog "$Name started with PID $($process.Id)."
    return $process
  }

  Wait-ForInfrastructure
  Write-SupervisorLog "Supervisor started from $ProjectRoot using $npmExe."

  $apps = @(
    @{
      Name = 'cloudflared'
      FilePath = $cloudflaredExe
      WorkingDirectory = $ProjectRoot
      Arguments = @('tunnel', '--config', $cloudflaredConfig, '--credentials-file', $cloudflaredCredentials, 'run', '5f28a08e-774c-4512-a995-2f39be805c7d')
      Process = $null
      Restarts = 0
      StartedAt = $null
    },
    @{
      Name = 'backend'
      FilePath = $npmExe
      WorkingDirectory = $backendRoot
      Arguments = @('run', 'start:prod')
      Process = $null
      Restarts = 0
      StartedAt = $null
    },
    @{
      Name = 'web'
      FilePath = $npmExe
      WorkingDirectory = $webRoot
      Arguments = @('run', 'start')
      Process = $null
      Restarts = 0
      StartedAt = $null
    }
  )

  while ($true) {
    foreach ($app in $apps) {
      $process = $app.Process
      if ($null -eq $process -or $process.HasExited) {
        if ($null -ne $process) {
          Write-SupervisorLog "$($app.Name) exited with code $($process.ExitCode)."
          $lifetime = (Get-Date) - $app.StartedAt
          if ($lifetime.TotalSeconds -ge 60) { $app.Restarts = 0 }
          $app.Restarts++
          $delay = [Math]::Min(30, [Math]::Pow(2, [Math]::Min($app.Restarts, 5)))
          Write-SupervisorLog "$($app.Name) restart in $delay seconds."
          Start-Sleep -Seconds $delay
        }
        $app.Process = Start-AppProcess -Name $app.Name `
          -FilePath $app.FilePath -WorkingDirectory $app.WorkingDirectory `
          -Arguments $app.Arguments
        $app.StartedAt = Get-Date
      }
    }
    Start-Sleep -Seconds 2
  }
} catch {
  New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
  Add-Content -LiteralPath (Join-Path $logRoot 'supervisor.log') `
    -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') FATAL $($_.Exception.ToString())" -Encoding UTF8
  throw
} finally {
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
