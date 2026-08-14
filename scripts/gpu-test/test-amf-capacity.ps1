<#
.SYNOPSIS
  Tests AMD AMF hardware encoding capacity and stability on this machine
  before Phase 1 is built on top of any assumptions about it.

.DESCRIPTION
  1. Confirms the local ffmpeg build exposes the requested AMF encoder.
  2. Runs an increasing number of CONCURRENT transcodes of one sample file
     (1, 2, 3, ... up to -MaxConcurrent).
  3. For each session, records exit code and the last reported ffmpeg
     "speed=" factor (>= 1.0x means it kept up in real time).
  4. Appends every run to a CSV so you can see exactly where quality/
     stability falls off a cliff, instead of guessing.

.PARAMETER SourceFile
  Path to a representative source video. Use something close to your real
  library (e.g. a 1080p H.264 file, and separately a 4K HEVC file) rather
  than a tiny test clip -- short/simple clips will overstate capacity.

.PARAMETER MaxConcurrent
  Highest concurrent session count to test up to. Default 6.

.PARAMETER Encoder
  h264_amf or hevc_amf. Run the script once per encoder -- AMD's H.264 and
  HEVC/AV1 encoders behave very differently in practice.

.EXAMPLE
  .\test-amf-capacity.ps1 -SourceFile "D:\media\sample-1080p.mkv" -MaxConcurrent 6 -Encoder h264_amf
  .\test-amf-capacity.ps1 -SourceFile "D:\media\sample-4k.mkv" -MaxConcurrent 4 -Encoder hevc_amf
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$SourceFile,

    [int]$MaxConcurrent = 6,

    [ValidateSet("h264_amf", "hevc_amf")]
    [string]$Encoder = "h264_amf",

    [string]$OutDir = "$PSScriptRoot\out",

    [string]$ResultsCsv = "$PSScriptRoot\gpu-test-results.csv"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $SourceFile)) {
    Write-Error "Source file not found: $SourceFile"
    exit 1
}

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Error "ffmpeg not found on PATH. Install a build with AMF support (e.g. the gyan.dev 'full' build) and re-run. See ../../docs/SETUP.md."
    exit 1
}

$encoderList = & ffmpeg -hide_banner -encoders 2>$null | Select-String $Encoder
if (-not $encoderList) {
    Write-Error "$Encoder not found in this ffmpeg build's encoder list. Your ffmpeg build likely lacks AMF support."
    exit 1
}
Write-Host "Found encoder: $Encoder" -ForegroundColor Green

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (-not (Test-Path $ResultsCsv)) {
    "timestamp,encoder,concurrent_sessions,session_index,exit_code,speed_realtime,status" |
        Out-File -FilePath $ResultsCsv -Encoding utf8
}

function Test-ConcurrentBatch {
    param([int]$Count)

    Write-Host "`n--- Testing $Count concurrent $Encoder session(s) ---" -ForegroundColor Cyan
    $jobs = @()

    for ($i = 1; $i -le $Count; $i++) {
        $outFile = Join-Path $OutDir "test_${Encoder}_${Count}_${i}.mp4"
        $logFile = Join-Path $OutDir "test_${Encoder}_${Count}_${i}.log"
        if (Test-Path $outFile) { Remove-Item $outFile -Force }

        # h264_amf (like most hardware H.264 encoders, AMD or NVIDIA) only
        # accepts 8-bit input. 10-bit sources (common from AV1/HEVC rips)
        # must be downsampled first, or the encoder fails to open outright.
        # hevc_amf is left native since HEVC Main10 hardware encode is normal.
        $ffArgs = @("-y", "-i", $SourceFile)
        if ($Encoder -eq "h264_amf") {
            $ffArgs += @("-vf", "format=nv12")
        }
        $ffArgs += @(
            "-c:v", $Encoder,
            "-quality", "balanced",
            "-b:v", "6M",
            "-t", "60",
            "-c:a", "aac",
            $outFile
        )

        $proc = Start-Process -FilePath "ffmpeg" -ArgumentList $ffArgs `
            -RedirectStandardError $logFile -NoNewWindow -PassThru

        # Touch .Handle immediately: a known PowerShell/.NET race loses ExitCode
        # on fast-exiting processes unless the handle is retained right after start.
        $null = $proc.Handle

        $jobs += [PSCustomObject]@{ Index = $i; Process = $proc; LogFile = $logFile }
    }

    $jobs | ForEach-Object { $_.Process.WaitForExit() }

    foreach ($job in $jobs) {
        $exitCode = $job.Process.ExitCode
        $log = Get-Content $job.LogFile -Raw -ErrorAction SilentlyContinue
        $speedMatch = [regex]::Matches($log, "speed=\s*([\d\.]+)x") | Select-Object -Last 1
        $speed = if ($speedMatch) { $speedMatch.Groups[1].Value } else { "n/a" }

        $status = if ($exitCode -ne 0) {
            "FAILED"
        } elseif ($speed -ne "n/a" -and [double]$speed -ge 1.0) {
            "OK-realtime"
        } else {
            "OK-slower-than-realtime"
        }

        Write-Host ("  session {0}: exit={1} speed={2}x status={3}" -f $job.Index, $exitCode, $speed, $status)

        "$(Get-Date -Format o),$Encoder,$Count,$($job.Index),$exitCode,$speed,$status" |
            Out-File -FilePath $ResultsCsv -Append -Encoding utf8
    }
}

for ($n = 1; $n -le $MaxConcurrent; $n++) {
    Test-ConcurrentBatch -Count $n
}

Write-Host "`nDone. Results: $ResultsCsv" -ForegroundColor Green
Write-Host "Find the highest concurrent_sessions value where EVERY row at that count is still OK-realtime with exit=0 -- that's your safe ceiling." -ForegroundColor Yellow
Write-Host "Re-run with -Encoder hevc_amf on the same source to compare stability/quality." -ForegroundColor Yellow
