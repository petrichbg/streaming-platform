#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$(id -u)" -eq 0 ]] || { echo 'Run with sudo: sudo ./install-linux.sh' >&2; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; OWNER="${SUDO_USER:-root}"; export DEBIAN_FRONTEND=noninteractive
apt-get update; apt-get install -y ca-certificates curl gnupg openssl docker.io; if ! apt-get install -y docker-compose-v2; then apt-get install -y docker-compose-plugin; fi; systemctl enable --now docker
if ! command -v node >/dev/null || [[ "$(node -p 'Number(process.versions.node.split(`.`)[0])' 2>/dev/null || echo 0)" -lt 20 ]]; then curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; apt-get install -y nodejs; fi
usermod -aG docker "$OWNER" || true
if [[ ! -f "$ROOT/.env" ]]; then cp "$ROOT/.env.example" "$ROOT/.env"; sed -i "s/POSTGRES_PASSWORD=changeme/POSTGRES_PASSWORD=$(openssl rand -hex 24)/; s/REDIS_PASSWORD=changeme/REDIS_PASSWORD=$(openssl rand -hex 24)/" "$ROOT/.env"; fi
set -a; source "$ROOT/.env"; set +a
if [[ ! -f "$ROOT/backend/.env" ]]; then cp "$ROOT/backend/.env.example" "$ROOT/backend/.env"; sed -i "s#streaming:changeme@localhost#streaming:${POSTGRES_PASSWORD}@localhost#; s#redis://:changeme@localhost#redis://:${REDIS_PASSWORD}@localhost#; s/JWT_SECRET=changeme-generate-a-real-random-secret/JWT_SECRET=$(openssl rand -hex 48)/" "$ROOT/backend/.env"; fi
[[ -f "$ROOT/web/.env.local" ]] || cp "$ROOT/web/.env.example" "$ROOT/web/.env.local"
chown -R "$OWNER":"$OWNER" "$ROOT"
sudo -u "$OWNER" npm --prefix "$ROOT/backend" ci; sudo -u "$OWNER" npm --prefix "$ROOT/backend" exec -- prisma generate; sudo -u "$OWNER" npm --prefix "$ROOT/backend" run build
sudo -u "$OWNER" npm --prefix "$ROOT/web" ci; sudo -u "$OWNER" npm --prefix "$ROOT/web" run build
"$ROOT/start-all.sh"; echo 'Installation complete. Log out and back in once to use Docker without sudo.'
