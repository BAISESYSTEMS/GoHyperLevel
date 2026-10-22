# Deploying HyperLevel

HyperLevel is one Node.js process with an embedded SQLite database – no Postgres, Redis or queue to run. All
state lives in one data folder (`PGHL_DATA_DIR`, `/data` in the container). Pick the way that fits you:

| Guide | Best for | HTTPS |
| --- | --- | --- |
| [Docker Compose + install script](docker.md) | Any Linux VPS (Hetzner, Hostinger, DigitalOcean, home server) | Caddy, automatic – including custom domains |
| [Hostinger VPS](hostinger.md) | Hostinger KVM plans, with or without their Docker Manager | Caddy or Hostinger's Traefik |
| [Coolify](coolify.md) | You already run Coolify (or Dokploy, CapRover …) | Coolify's proxy |
| [Railway / Render](railway-render.md) | No server to maintain, pay per use | Platform |
| [Plain Node.js](node.md) | No Docker, systemd/pm2 | Your reverse proxy |

## Sizing

- **Small agency (≤ 20 sub-accounts, ≤ 50k contacts):** 1 vCPU, 1 GB RAM, 10 GB disk is plenty.
- **With the Video-Studio (OpenShorts):** add 3–4 vCPUs, 6–8 GB RAM and ~10 GB for the image and models.
- HyperLevel runs as **one instance** (SQLite). Scale up, not out.

## Checklist for every install

1. **`PGHL_BASE_URL`** = the exact public `https://` address. Links in e-mails, booking pages, invoices and
   webhook signatures (Twilio, Meta, Stripe) depend on it.
2. **First login:** set `PGHL_ADMIN_EMAIL` + `PGHL_ADMIN_PASSWORD` for the first start, or open the app and
   create the admin on the setup page (shown until the first account exists; `POST /api/auth/setup`).
3. **Back up the data folder** (database, uploads and the `secret` that encrypts stored credentials). HyperLevel
   makes a daily SQLite backup into `<data>/backups`; copy it off the server too.
4. **Check the deploy:** `curl https://crm.your-domain.com/api/version` → `{"name":"HyperLevel","version":"…"}`.
5. Turn on two-factor login for admins (*Einstellungen → Mein Konto*).

All options: [`.env.example`](../../.env.example) · German reference: [docs/self-hosting.md](../self-hosting.md) ·
Public demo instance: [docs/demo-mode.md](../demo-mode.md).
