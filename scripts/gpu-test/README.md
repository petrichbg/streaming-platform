# GPU capacity test

Purpose: find out, on the real machine, how many concurrent AMF-encoded
transcodes the RX 7900 XTX can sustain in real time before committing to any
transcode-pipeline design decisions in Phase 1.

## Prerequisites

1. FFmpeg with AMF support on the Windows host (native, not inside Docker).
   The gyan.dev "full" build includes it: https://www.gyan.dev/ffmpeg/builds/
   Add the `bin` folder to your PATH, then confirm with:

   ```powershell
   ffmpeg -hide_banner -encoders | Select-String amf
   ```

   You should see `h264_amf`, `hevc_amf`, and possibly `av1_amf` listed.

2. A representative sample video file — not a tiny test clip. Ideally:
   - one 1080p H.264 source (typical direct-play candidate)
   - one 4K HEVC source (the harder case)

## Running it

```powershell
cd scripts\gpu-test
.\test-amf-capacity.ps1 -SourceFile "D:\media\sample-1080p.mkv" -MaxConcurrent 6 -Encoder h264_amf
.\test-amf-capacity.ps1 -SourceFile "D:\media\sample-4k.mkv"    -MaxConcurrent 4 -Encoder hevc_amf
```

Each run ramps from 1 up to `-MaxConcurrent` simultaneous 60-second transcodes
and appends every session's result to `gpu-test-results.csv` in this folder.

## Reading the results

Open `gpu-test-results.csv`. For each `concurrent_sessions` value, check
every row at that count:

- `status = OK-realtime` and `exit_code = 0` for **all** sessions at that
  count → the GPU comfortably handled that load.
- Any `FAILED` or `OK-slower-than-realtime` row → you've found the ceiling.
  The safe concurrent-transcode limit is the highest count where every
  session still passed.

Known from community reports (see `../../docs/ARCHITECTURE.md` risk table):
AMD's `h264_amf` encoder has had stability issues (CreateComponent
failures) on some driver/firmware combinations for RX 7900 XTX, and its
H.264 quality trails NVENC. `hevc_amf`/`av1_amf` tend to be more solid. If
`h264_amf` fails outright or the results look unstable, treat that as a
real finding — plan around HEVC output plus a CPU (`libx264`) fallback path
rather than assuming H.264 AMF will just work.

This number (safe concurrent ceiling) directly drives Phase 1's transcode
queue design — how many jobs it's allowed to run at once, and when to fall
back to direct play or CPU encode.
