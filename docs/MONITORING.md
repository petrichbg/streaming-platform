# Monitoring

`StreamingPlatformMonitoring` runs every five minutes in the interactive
Windows session. The task checks:

- local and public web/API endpoints;
- the production supervisor task;
- an authenticated PostgreSQL query and Redis `PING`;
- queued, running, failed and potentially stuck transcode jobs;
- free space on `C:`, `D:` and the Google Drive backup volume `G:`;
- recent failed login, playback and transcode requests from structured audit
  records.

The default disk thresholds are 25 GB/8% for `C:`, 50 GB/10% for `D:` and
10 GB/5% for `G:`. The transcode thresholds are more than 20 queued jobs, an
active job older than 180 minutes, or any failed job in the last 24 hours.

## Status and logs

```powershell
.\scripts\monitor-status.ps1
.\scripts\monitor.ps1
```

Runtime state and logs, all excluded from Git:

- `var\monitor\state.json` — last health state;
- `var\monitor\monitor.jsonl` — every monitoring snapshot;
- `var\monitor\alerts.log` — alert and recovery transitions;
- `var\logs\backend-*.stdout.log` — NestJS logs and structured audit records.

Audit records never include request bodies, passwords, email addresses, JWTs
or query strings. They include only event type, path, method, status, duration,
IP and a truncated user-agent. Login alerts start at five failures in ten
minutes; playback and transcode-request alerts start at three.

## Notifications

Every state transition writes an alert log entry, attempts a Windows
Application Event Log record and displays a Windows notification. Repeated
checks in the same failed state do not send duplicate notifications.

For remote alerts, set `MONITOR_WEBHOOK_URL` in the root `.env` to a trusted
Slack/Discord-compatible webhook and restart the monitoring task. The URL is a
secret and must not be committed.

## Reinstall the task

```powershell
.\scripts\install-monitor-task.ps1 -EveryMinutes 5
```
