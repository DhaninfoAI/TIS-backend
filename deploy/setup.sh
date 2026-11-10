#!/usr/bin/env bash
# One-time server set-up for the SmartFill backend + dashboard (Ubuntu 22.04 / 24.04, run as root).
# Before running: the domain's DNS A record points at this server, the repo is cloned, backend/.env exists.
#   cd /opt/smartfill/backend && sudo bash deploy/setup.sh smartfill.boost.com you@boost.com
# Safe to run again (it skips what is already done). Full guide: deploy/DEPLOY.md
set -euo pipefail

DOMAIN="${1:-}"; EMAIL="${2:-}"
if [[ -z "$DOMAIN" || -z "$EMAIL" ]]; then echo "Usage: sudo bash deploy/setup.sh <domain> <email for certificate notices>"; exit 1; fi
[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)."; exit 1; }
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "Checking backend/.env"
ENV="$APP_DIR/.env"
[[ -f "$ENV" ]] || { echo "Missing $ENV. Create it first (DEPLOY.md step 4), then run this again."; exit 1; }
grep -qE '^\s*ALLOW_DEV_TOKEN\s*=\s*0\s*$' "$ENV" || { echo "Set ALLOW_DEV_TOKEN=0 in $ENV first (otherwise the public 'dev-token' is an admin key)."; exit 1; }
grep -qE '^\s*JWT_SECRET\s*=\s*\S{32,}' "$ENV" || { echo "Set JWT_SECRET in $ENV to a long random value (e.g. the output of: openssl rand -base64 48)."; exit 1; }
grep -qE '^\s*DATABASE_URL\s*=\s*\S+' "$ENV" || echo "Note: no DATABASE_URL in .env, so data is kept in files under $APP_DIR/data."

say "Installing packages (nginx, certbot, Node.js 22)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx certbot curl ca-certificates git ufw
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

say "App user, folders and dependencies"
id smartfill >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin smartfill
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund
mkdir -p "$APP_DIR/data"
chown -R smartfill:smartfill "$APP_DIR/data"
chown smartfill:smartfill "$ENV"; chmod 600 "$ENV"   # only the app can read the secrets

say "Service (starts at boot, restarts if it stops)"
sed "s#/opt/smartfill/backend#$APP_DIR#g" "$APP_DIR/deploy/smartfill.service" > /etc/systemd/system/smartfill.service
[[ "$APP_DIR" == /home/* || "$APP_DIR" == /root/* ]] && sed -i '/^ProtectHome=/d' /etc/systemd/system/smartfill.service
systemctl daemon-reload
systemctl enable smartfill >/dev/null
systemctl restart smartfill
for i in $(seq 1 30); do curl -fsS http://127.0.0.1:4010/v1/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:4010/v1/health >/dev/null || { echo "The app did not start. See: journalctl -u smartfill -n 50"; exit 1; }
echo "App is running on 127.0.0.1:4010"

say "HTTPS certificate for $DOMAIN"
mkdir -p /var/www/certbot
rm -f /etc/nginx/sites-enabled/default
if [[ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
  # temporary plain-HTTP site so Let's Encrypt can check the domain
  cat > /etc/nginx/sites-available/smartfill <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location ^~ /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 404; }
}
EOF
  ln -sf /etc/nginx/sites-available/smartfill /etc/nginx/sites-enabled/smartfill
  nginx -t && systemctl reload nginx
  certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" -m "$EMAIL" --agree-tos --no-eff-email -n
fi
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

say "nginx site"
sed "s#smartfill.example.com#$DOMAIN#g" "$APP_DIR/deploy/nginx-smartfill.conf" > /etc/nginx/sites-available/smartfill
ln -sf /etc/nginx/sites-available/smartfill /etc/nginx/sites-enabled/smartfill
nginx -t
systemctl reload nginx

say "Firewall (SSH + web only; port 4010 stays closed)"
SSH_PORT="$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}')"; SSH_PORT="${SSH_PORT:-22}"
ufw allow "$SSH_PORT/tcp" >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null
ufw status | sed -n '1,12p'

say "Done"
echo "Dashboard: https://$DOMAIN/dashboard"
echo "API:       https://$DOMAIN/v1/health"
echo "Logs:      journalctl -u smartfill -f"
echo "Update:    sudo bash $APP_DIR/deploy/update.sh"
