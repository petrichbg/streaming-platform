# Transcode reliability

## Dashboard actions

- **Cancel** stops queued or running work and marks the job `CANCELLED`.
- **Retry** reruns a failed or cancelled job with its current effective encoder.
- **Requeue** discards the existing rendition and starts again with the originally requested hardware encoder. The dashboard requires an inline confirmation before deleting HLS output.

All actions require an authenticated administrator. Job status is communicated with an icon, text, and colour so it does not depend on colour alone.

## AMF fallback

An AMF initialization or device failure causes one automatic retry with `libx264`. The job records both the effective encoder and `fallbackFrom`, so the dashboard shows that the CPU fallback was used. Cancellation always wins over fallback and completion.

## HLS publishing and cleanup

FFmpeg writes into a job-specific work directory. The service validates the master playlist, child playlists, segment names, and non-empty segment files before atomically publishing the rendition. Failed or cancelled work is discarded.

At backend startup, work/stale directories older than one hour and incomplete or corrupt current-format renditions older than one hour are removed automatically. Legacy `index.m3u8` renditions are preserved.

## Verification commands

Run from `backend`:

```powershell
npm run build
node scripts/transcode-processor-test.cjs
node scripts/transcode-actions-test.cjs
node scripts/playback-reliability-test.mjs https://api.petrich.live 50
```

The playback reliability test aborts HLS requests mid-stream, mixes Range seek requests with segment downloads from independently scoped playback tokens, and verifies API health afterward.
