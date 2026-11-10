#!/usr/bin/env bash
# Put the latest code from GitHub live (run as root on the server):
#   sudo bash /opt/smartfill/backend/deploy/update.sh
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)."; exit 1; }
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
git pull --ff-only
npm ci --omit=dev --no-audit --no-fund
systemctl restart smartfill
for i in $(seq 1 30); do curl -fsS http://127.0.0.1:4010/v1/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:4010/v1/health >/dev/null && echo "Updated and running: $(git log -1 --format='%h %s')" || { echo "Not running. See: journalctl -u smartfill -n 50"; exit 1; }
