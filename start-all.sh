#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; RUN="$ROOT/var/run"; LOGS="$ROOT/var/logs"; mkdir -p "$RUN" "$LOGS"
for file in "$ROOT/.env" "$ROOT/backend/.env" "$ROOT/web/.env.local"; do [[ -f "$file" ]] || { echo "Missing $file. Run ./install-linux.sh first." >&2; exit 1; }; done
docker compose --project-directory "$ROOT" up -d postgres redis traefik
(cd "$ROOT/backend" && npx prisma migrate deploy)
[[ -f "$RUN/backend.pid" ]] && "$ROOT/stop-all.sh" --keep-infrastructure
(cd "$ROOT/backend"; exec nohup node dist/main.js) >"$LOGS/backend.stdout.log" 2>"$LOGS/backend.stderr.log" & echo $! >"$RUN/backend.pid"
(cd "$ROOT/web"; exec nohup node node_modules/next/dist/bin/next start -p 3001) >"$LOGS/web.stdout.log" 2>"$LOGS/web.stderr.log" & echo $! >"$RUN/web.pid"
if command -v cloudflared >/dev/null && [[ -f "$ROOT/cloudflared/streaming-platform.yml" && -f "$ROOT/var/cloudflared/credentials.json" ]]; then nohup cloudflared tunnel --config "$ROOT/cloudflared/streaming-platform.yml" --credentials-file "$ROOT/var/cloudflared/credentials.json" run >"$LOGS/cloudflared.stdout.log" 2>"$LOGS/cloudflared.stderr.log" & echo $! >"$RUN/cloudflared.pid"; fi
sleep 3; echo "Started: API http://localhost:3000 | Web http://localhost:3001"
