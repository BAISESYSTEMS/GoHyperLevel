# Plain Node.js (no Docker)

Requirements: **Node.js 22.13+**, ~300 MB RAM, a reverse proxy for HTTPS.

```bash
git clone https://github.com/BAISESYSTEMS/GoHyperLevel.git /opt/gohigh && cd /opt/gohigh
npm ci && npm run build && npm prune --omit=dev
PGHL_BASE_URL=https://crm.example.com PGHL_DATA_DIR=/var/lib/gohigh npm start
```

Create the first admin in the browser (setup page) or start once with `PGHL_ADMIN_EMAIL` and
`PGHL_ADMIN_PASSWORD`. All variables: [`.env.example`](../../.env.example) – the app reads them from the
environment (it does not load `.env` by itself; systemd's `EnvironmentFile=` does).

## systemd

```ini
# /etc/systemd/system/gohigh.service
[Unit]
Description=HyperLevel
After=network-online.target

[Service]
User=gohigh
WorkingDirectory=/opt/gohigh
EnvironmentFile=/etc/gohigh.env
Environment=NODE_ENV=production PGHL_DATA_DIR=/var/lib/gohigh PGHL_BEHIND_PROXY=1 PGHL_HOST=127.0.0.1
ExecStart=/usr/bin/node --no-warnings dist-server/server/index.js
Restart=always
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/gohigh

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home /var/lib/gohigh gohigh && sudo mkdir -p /var/lib/gohigh && sudo chown gohigh: /var/lib/gohigh
sudo systemctl daemon-reload && sudo systemctl enable --now gohigh
```

`PGHL_BEHIND_PROXY=1` tells HyperLevel to read client IPs from `X-Forwarded-For` (rate limits, audit log); on
its own it also makes HyperLevel listen on all interfaces, so `PGHL_HOST=127.0.0.1` keeps it local when the proxy
runs on the same machine.

## Reverse proxy

Caddy (`/etc/caddy/Caddyfile`):

```
crm.example.com {
	reverse_proxy 127.0.0.1:4700
}
```

nginx: proxy to `http://127.0.0.1:4700`, pass `Host` and `X-Forwarded-For`, allow request bodies up to
your largest upload (`client_max_body_size 200m;` for APK and video uploads). For custom funnel domains on
nginx + certbot see the [domain agent](../../deploy/examples/nginx-domain-agent/README.md).

## Updates

```bash
cd /opt/gohigh && git pull && npm ci && npm run build && npm prune --omit=dev && sudo systemctl restart gohigh
```
