# Hosting the SmartFill backend + dashboard

> **Live (2026-11-11)**: hosted under a path prefix on the Boost dashboard host:
> dashboard `https://dashboard.boost-usa.com/tis/dashboard`, API base `https://dashboard.boost-usa.com/tis`
> (the extension's `apiBase`), rules `https://dashboard.boost-usa.com/tis/rules`. See "Hosting under a path" at the
> end; the steps below describe a server of its own (`smartfill.boost.com`).

One server runs everything: the API the extension calls (`/v1/…`), the dashboard (`/dashboard`) and the rules page
(`/rules`). nginx sits in front with HTTPS; the Node app listens on `127.0.0.1:4010` only.

```
Chrome extension ─┐
                  ├─ https://smartfill.boost.com ─► nginx (443, HTTPS) ─► node server.mjs (127.0.0.1:4010) ─► Neon + OpenAI
Dashboard browser ┘                                                         └─ photos on disk: backend/data/photos
```

Files in this folder:

| File | What |
|---|---|
| `setup.sh` | One-time set-up: Node 22, nginx, HTTPS certificate, service, firewall |
| `update.sh` | Put the latest code from GitHub live |
| `nginx-smartfill.conf` | The nginx site (setup.sh fills in the domain) |
| `smartfill.service` | systemd service: starts at boot, restarts if it stops |

Example values below: server `164.52.205.183`, domain `smartfill.boost.com`. Use your own sub-domain if you prefer.

---

## Step 1. DNS record (at whoever manages boost.com)

Add one record:

| Type | Name / Host | Value / Points to | TTL |
|---|---|---|---|
| **A** | `smartfill` | `164.52.205.183` | 300 (or Auto) |

- That makes `smartfill.boost.com` point at the server. Nothing else in the domain changes.
- No AAAA record unless the server has an IPv6 address.
- If the domain is on **Cloudflare**, set the record to **DNS only** (grey cloud), not Proxied: the proxy limits upload
  size and can hold back the live progress stream.
- Check it from your PC (wait a few minutes after adding it):

```bash
nslookup smartfill.boost.com
```

It must answer `164.52.205.183` before Step 5.

## Step 2. Log in to the server and change the password

From PowerShell or a terminal on your PC:

```bash
ssh root@164.52.205.183
```

Then, on the server, set a new password (the old one was shared in a chat):

```bash
passwd
```

Check the system: `lsb_release -a` should say Ubuntu 22.04 or 24.04 (the script is written for Ubuntu).

## Step 3. Get the code onto the server (the repo is private)

Give the server its own read-only key for the repo (a "deploy key"). On the server:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/smartfill_deploy -N "" -C "smartfill-server"
```

```bash
cat ~/.ssh/smartfill_deploy.pub
```

Copy the line it prints. On GitHub: **TIS-backend → Settings → Deploy keys → Add deploy key**, title "server",
paste the line, leave **Allow write access** unticked, **Add key**.

Back on the server, tell SSH to use that key for GitHub, then clone:

```bash
printf 'Host github-smartfill\n  HostName github.com\n  User git\n  IdentityFile ~/.ssh/smartfill_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
```

```bash
apt-get update && apt-get install -y git
```

```bash
mkdir -p /opt/smartfill && git clone git@github-smartfill:DhaninfoAI/TIS-backend.git /opt/smartfill/backend
```

(Answer `yes` to the GitHub fingerprint question the first time.)

## Step 4. The secrets file (`backend/.env`)

Easiest: copy the `.env` from your PC, then change three lines on the server. From **PowerShell on your PC**:

```powershell
scp "C:\Users\Gulshan Pathode\Desktop\TIS\backend\.env" root@164.52.205.183:/opt/smartfill/backend/.env
```

On the server, make a random secret and open the file:

```bash
openssl rand -base64 48
```

```bash
nano /opt/smartfill/backend/.env
```

Make sure these lines are in it (add or change them; save with Ctrl+O, Enter, Ctrl+X):

```
ALLOW_DEV_TOKEN=0
JWT_SECRET=<paste the random value from openssl>
ADMIN_EMAIL=<your admin email>
```

- `ALLOW_DEV_TOKEN=0` is **required**: otherwise the token `dev-token`, which is written in the code, works as an
  admin key on the internet. `setup.sh` refuses to run without it.
- `DATABASE_URL` and `OPENAI_API_KEY` come over from your PC's file. With the same Neon database, all accounts,
  licences, seats, reviews and the TIS logo are already there.
- `JWT_SECRET` signs the 15-minute access passes. Without it the app makes one up and keeps it in the database;
  putting it in `.env` keeps it apart from the data, so a copy of the database alone cannot be used to forge an admin
  pass. Setting or changing it signs nobody out: the extension and the dashboard renew their pass with their
  refresh token, which does not depend on this secret.
- `PORT` in the file does not matter: the service always uses 127.0.0.1:4010.

## Step 5. Run the set-up script

On the server (DNS from Step 1 must already point here; use your real email for certificate notices):

```bash
cd /opt/smartfill/backend && bash deploy/setup.sh smartfill.boost.com you@boost.com
```

It installs Node 22, nginx and certbot, installs the app's packages, starts the `smartfill` service, gets a free
HTTPS certificate from Let's Encrypt (running it means you accept Let's Encrypt's terms), writes the nginx site and
turns on the firewall (SSH + web only). It ends by printing the dashboard address. If it stops with a message, fix
that one thing and run the same command again.

## Step 6. Check it

- Open `https://smartfill.boost.com/dashboard` and sign in with the admin account and with the customer account.
- `https://smartfill.boost.com/v1/health` shows `{"ok":true}`.
- `https://smartfill.boost.com/ext/sidepanel/sidepanel.html` shows "not found" (developer pages are closed on purpose).

On the server:

```bash
systemctl status smartfill
```

```bash
journalctl -u smartfill -f
```

(Ctrl+C leaves the log; the app keeps running.)

## Step 7. Point the extension at the server

In the extension repo, `common/config.js` (`apiBase`) and `manifest.json` (`host_permissions`) still say
`http://localhost:4010`. Change both to `https://smartfill.boost.com`, reload the extension (↻ in
`chrome://extensions`) and sign in again. (Claude can make this change once the domain is final.)

## Step 8. Stop the backend on your PC

Once the server works, stop the local backend on your PC (port 4010). Both use the same Neon database, so two
running copies would both clean up photos and count seats.

---

## Hosting under a path (e.g. `/tis`)

When the app shares a host with other sites, serve it under a prefix. In `backend/.env` set `BASE_PATH=/tis`
(it scopes the dashboard's sign-in cookie to `/tis/v1/auth`), restart (`systemctl restart smartfill`), and in the
host's nginx `server { … }` add:

```nginx
location /tis/ {
    proxy_pass http://127.0.0.1:4010;          # no trailing slash: the app gets /tis/… and removes the prefix itself
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 64m;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}
location ~ ^/tis/v1/analyses/[^/]+/events$ {   # live review progress: no buffering
    proxy_pass http://127.0.0.1:4010;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
}
location ~ ^/tis/(ext/|fixtures/|writer-test|harness-chrome-stub\.js|content/|index\.html) { return 404; }
```

An nginx that strips the prefix (`proxy_pass http://127.0.0.1:4010/;`) also works. The dashboard and rules pages
work out the prefix from their own address, so no file needs editing on the server: hand edits to
`public/*.html` or `server.mjs` there make `update.sh` (`git pull --ff-only`) fail. If the server has some, run
`git -C /opt/smartfill/backend status`, then `git -C /opt/smartfill/backend checkout -- public server.mjs` before
updating.

## Later

- **New code**: push to GitHub, then on the server: `bash /opt/smartfill/backend/deploy/update.sh`
- **Certificate**: renews by itself (certbot's timer); nginx reloads after a renewal.
- **Reboots**: the service and nginx start by themselves.
- **Photos** are kept in `/opt/smartfill/backend/data/photos` (photos of unreviewed orders are removed after 24 h).
  The server starts with none: the extension uploads what is missing the next time an order is opened; earlier AI
  photo results in the database are reused.
- **Something wrong**: `journalctl -u smartfill -n 100` (app), `tail -n 50 /var/log/nginx/error.log` (nginx),
  `nginx -t` (config check), `systemctl restart smartfill`.
