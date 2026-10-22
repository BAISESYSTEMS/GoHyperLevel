# Docker Compose (any Linux server)

## One command

On a server with Docker and a DNS record (`A`/`AAAA`) for your domain pointing at it:

```bash
curl -fsSL https://raw.githubusercontent.com/gohyperlevel/gohyperlevel/main/scripts/install.sh | bash
```

The script asks for the domain and your admin e-mail, generates a strong admin password and `PGHL_SECRET`,
writes `/opt/gohigh/.env` (mode 600), pulls the prebuilt image (or builds it from source if none is
published) and starts HyperLevel with **Caddy** on ports 80/443. The first HTTPS request takes a few seconds
while Caddy fetches the Let's Encrypt certificate. Non-interactive:

```bash
GOHIGH_DOMAIN=crm.example.com GOHIGH_ADMIN_EMAIL=you@example.com bash install.sh --yes
```

Options: `GOHIGH_DIR` (install folder), `GOHIGH_REF` (branch or tag, e.g. `v0.0.18`), `GOHIGH_NO_CADDY=1`
(you already have a reverse proxy – HyperLevel then listens on `127.0.0.1:4700`).

## By hand

```bash
git clone https://github.com/gohyperlevel/gohyperlevel.git && cd gohyperlevel
cp .env.example .env          # set PGHL_BASE_URL and PGHL_DOMAIN (and optionally the first admin)
docker compose --profile caddy up -d
```

- Without the `caddy` profile HyperLevel is published on `127.0.0.1:4700` only – put your own proxy in front.
- `docker compose pull gohigh` before `up` uses the prebuilt multi-arch image (`GOHIGH_IMAGE`, default
  `ghcr.io/gohyperlevel/gohyperlevel:latest`, pin e.g. `:0.0.18`) instead of building locally.
- **Custom domains** for funnels, websites and client logins work automatically with Caddy: customers point
  their domain at the server, Caddy asks `GET /api/tls/ask?domain=…` and only requests certificates for
  domains HyperLevel knows.
- **Video-Studio:** `docker compose --profile caddy --profile openshorts up -d` builds and starts OpenShorts
  next to HyperLevel (large CPU image, first build 10–20 min). Then *Agentur → Integrationen → OpenShorts* →
  `http://openshorts:8000`. Details: [docs/video-studio.md](../video-studio.md).

## Updates

```bash
cd /opt/gohigh && bash scripts/install.sh            # pulls the new image/source, keeps .env
# or by hand:
git pull && docker compose pull gohigh; docker compose --profile caddy up -d --build
```

Database migrations run automatically on start. Check the version: sidebar footer or `/api/version`.

## Backups and moving servers

All data is in the `gohigh_gohigh-data` volume. Daily backups land in `/data/backups` inside it. Copy them
off the server, e.g.:

```bash
docker compose cp gohigh:/data/backups ./gohigh-backups
```

Restoring/moving: stop HyperLevel, copy the whole volume (or `pghl.db`, `uploads/`, `form-files/`, `secret`)
to the new server, start again.

## Notes

- The container runs the app as the unprivileged `node` user (uid 1000); on start it hands the data folder
  to that user if needed. Bind mounts work too (`-v /srv/gohigh:/data`).
- Coming from the old `compose.yaml` (service `crm`, volume `<project>_pghl-data`)? Either keep using your
  old volume by declaring it `external: true` with its name in `docker-compose.yml`, or copy its content
  into the new volume once.
- Logs: `docker compose logs -f gohigh`. Health: `docker inspect --format '{{.State.Health.Status}}' gohigh-gohigh-1`.
