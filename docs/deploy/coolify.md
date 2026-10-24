# Coolify

[Coolify](https://coolify.io) builds HyperLevel from the repository and puts its proxy (with HTTPS) in front.

1. **New resource → Public repository** → `https://github.com/BAISESYSTEMS/GoHyperLevel` (or your fork), branch `main`.
2. **Build pack: Dockerfile** (the repository's `Dockerfile`). Port: **4700**.
3. **Domain:** e.g. `https://crm.your-domain.com` (Coolify issues the certificate).
4. **Persistent storage:** add a volume mounted at **`/data`**.
5. **Environment variables:**
   - `PGHL_BASE_URL=https://crm.your-domain.com`
   - `PGHL_ADMIN_EMAIL` / `PGHL_ADMIN_PASSWORD` (first start only – or use the setup page)
   - `PGHL_SECRET` – a long random string (Coolify can generate one); never change it afterwards
   - optional: anything from [`.env.example`](../../.env.example)
6. **Health check:** path `/healthz` (the image also has a Docker `HEALTHCHECK`).
7. Deploy. Updates: redeploy (or enable auto-deploy on push).

Prefer the prebuilt image? Create a **Docker image** resource with `ghcr.io/baisesystems/hyperlevel:latest` and the
same port, volume and variables.

**Custom domains** (funnels, client logins): add each domain to the resource's domain list in Coolify so its
proxy routes it and issues a certificate. The same steps work on **Dokploy** and **CapRover** (Dockerfile
deploy, port 4700, volume `/data`).
