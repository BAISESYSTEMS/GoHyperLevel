# Hostinger VPS

Any Hostinger **KVM** VPS (KVM 1 is enough without the Video-Studio) runs HyperLevel. Two options:

## A) Plain Ubuntu VPS – install script (recommended)

1. hPanel → VPS → OS: **Ubuntu 24.04 with Docker** (or plain Ubuntu and install Docker:
   `curl -fsSL https://get.docker.com | sh`).
2. DNS (Hostinger or your registrar): `A` record `crm` → the VPS IP (and `AAAA` for IPv6 if you use it).
3. SSH in and run:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/BAISESYSTEMS/hyperlevel/main/scripts/install.sh | bash
   ```

4. Open `https://crm.your-domain.com` and sign in with the printed login. Open ports 80 and 443 in the VPS
   firewall (hPanel → VPS → Firewall) if you use it.

## B) Hostinger "Docker Manager" / Traefik template

If you picked the **Docker + Traefik** template and manage projects in hPanel's Docker Manager:

1. Docker Manager → **Compose** → paste [`deploy/examples/hostinger/compose.yaml`](../../deploy/examples/hostinger/compose.yaml).
2. Environment: `PGHL_DOMAIN`, `PGHL_BASE_URL`, and for the first start `PGHL_ADMIN_EMAIL` / `PGHL_ADMIN_PASSWORD`.
   Optionally pin the image: `GOHIGH_IMAGE=ghcr.io/baisesystems/hyperlevel:0.0.18`.
3. Deploy. Traefik (entry points `web`/`websecure`, resolver `letsencrypt` – Hostinger's names) issues the
   certificate. Other Traefik setups: `TRAEFIK_ENTRYPOINT`, `TRAEFIK_HTTP_ENTRYPOINT`, `TRAEFIK_CERTRESOLVER`.
4. Update: pull the new image and recreate the project.

No registry access? [`build-from-source.compose.yaml`](../../deploy/examples/hostinger/build-from-source.compose.yaml)
clones the repository into the volume on first start and builds there (`PGHL_REBUILD=1` once to update).

**Custom domains with Traefik:** add the domain to the router rule
(``Host(`crm.example.com`) || Host(`www.customer-site.com`)``) and recreate the container – or use option A,
where Caddy handles custom domains automatically.

## Hostinger tips

- Daily backups: hPanel's VPS snapshots plus HyperLevel's own backups in the volume (`/data/backups`).
- E-mail: Hostinger mailboxes work as SMTP for sending (`smtp.hostinger.com`, port 465) – set per sub-account
  under *Einstellungen → E-Mail & SMS*.
