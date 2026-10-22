# Railway and Render

Both platforms build the repository's `Dockerfile`. HyperLevel needs **one instance with a persistent disk**
mounted at `/data` (SQLite) – don't scale it horizontally.

## Railway

1. **New project → Deploy from GitHub repo** (your fork of HyperLevel). `railway.json` selects the Dockerfile
   build, the health check (`/healthz`) and a single replica.
2. **Volume:** service → *Volumes* → mount path **`/data`**.
3. **Variables:** `PGHL_BASE_URL` (your Railway domain or custom domain, with `https://`),
   `PGHL_SECRET` (`${{secret(64)}}`), and for the first start `PGHL_ADMIN_EMAIL` / `PGHL_ADMIN_PASSWORD`.
   Railway sets `PORT`; HyperLevel listens on it.
4. **Networking:** generate a domain or add your own.

## Render

1. **New → Blueprint** with your fork – `render.yaml` defines a Docker web service with a 5 GB disk at
   `/data`, the health check and a generated `PGHL_SECRET` (a disk requires a paid instance type).
2. Fill in `PGHL_BASE_URL` (the `onrender.com` URL or your domain), `PGHL_ADMIN_EMAIL`, `PGHL_ADMIN_PASSWORD`.
3. Deploy. Custom domain: service → *Settings → Custom Domains*.

## Notes for both

- Platform disks are often owned by root; the image hands `/data` to its unprivileged user on start.
- Webhooks from Twilio, Meta and Stripe need the exact public address in `PGHL_BASE_URL`.
- Custom funnel domains: add them as custom domains on the platform (each one) – automatic on-demand
  certificates like with Caddy are not available there.
- Background jobs (workflow waits, reminders, syncs) run inside the web process – keep the service always on
  (no sleep/scale-to-zero).
