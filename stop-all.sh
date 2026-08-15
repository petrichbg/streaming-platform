#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; RUN="$ROOT/var/run"; KEEP=false; [[ "${1:-}" == "--keep-infrastructure" ]] && KEEP=true
for name in cloudflared web backend; do file="$RUN/$name.pid"; if [[ -f "$file" ]]; then pid="$(cat "$file")"; kill "$pid" 2>/dev/null || true; rm -f "$file"; echo "Stopped $name (PID $pid)"; fi; done
$KEEP || docker compose --project-directory "$ROOT" down
echo 'All requested services stopped. Persistent database volumes were preserved.'
