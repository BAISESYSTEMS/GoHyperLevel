#!/usr/bin/env bash
# HyperLevel installer – Docker Compose + Caddy (automatic HTTPS) on a fresh Linux server.
#
#   curl -fsSL https://raw.githubusercontent.com/BAISESYSTEMS/GoHyperLevel/main/scripts/install.sh | bash
#
# Asks for your domain and admin e-mail, generates the admin password and the app secret, writes .env
# and starts HyperLevel. Non-interactive: GOHIGH_DOMAIN=crm.example.com GOHIGH_ADMIN_EMAIL=you@example.com
# bash install.sh --yes. Re-running it updates an existing install and keeps its .env.
#
# Environment: GOHIGH_DIR (default /opt/gohigh, or ~/gohigh without root), GOHIGH_REPO (git URL),
# GOHIGH_REF (branch/tag), GOHIGH_DOMAIN, GOHIGH_ADMIN_EMAIL, GOHIGH_NO_CADDY=1 (own proxy).
set -euo pipefail

REPO="${GOHIGH_REPO:-https://github.com/BAISESYSTEMS/GoHyperLevel.git}"
REF="${GOHIGH_REF:-main}"
RAW="${GOHIGH_RAW:-https://raw.githubusercontent.com/BAISESYSTEMS/GoHyperLevel/${REF}}"
if [ "$(id -u)" = "0" ]; then DEFAULT_DIR=/opt/gohigh; else DEFAULT_DIR="$HOME/gohigh"; fi
DIR="${GOHIGH_DIR:-$DEFAULT_DIR}"
YES=0
for a in "$@"; do
  case "$a" in
    -y|--yes) YES=1 ;;
    -h|--help) sed -n '2,12p' "$0" 2>/dev/null || true; exit 0 ;;
  esac
done

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

# Reads from the terminal even when the script itself comes from a pipe (curl | bash).
ask() {
  local prompt="$1" default="${2:-}" answer=""
  if [ "$YES" = "1" ] || [ ! -r /dev/tty ]; then printf '%s' "$default"; return; fi
  printf '%s%s: ' "$prompt" "${default:+ [$default]}" > /dev/tty
  IFS= read -r answer < /dev/tty || true
  printf '%s' "${answer:-$default}"
}

rand() { # $1 = length
  if command -v openssl > /dev/null 2>&1; then openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "$1"
  else LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$1"; fi
}

sed_escape() { printf '%s' "$1" | sed -e 's/[\\\/&#]/\\&/g'; }
valid_domain() { [[ "$1" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]]; }
valid_email() { [[ "$1" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; }

# --- prerequisites -------------------------------------------------------------------------------------
command -v docker > /dev/null 2>&1 || die "Docker is not installed. Install it first: https://docs.docker.com/engine/install/ (or: curl -fsSL https://get.docker.com | sh)"
docker compose version > /dev/null 2>&1 || die "The Docker Compose plugin is missing (docker compose …). See https://docs.docker.com/compose/install/"
docker info > /dev/null 2>&1 || die "Cannot talk to the Docker daemon – run as root, or add your user to the docker group."

# --- get the files ------------------------------------------------------------------------------------
mkdir -p "$DIR"
cd "$DIR"
if command -v git > /dev/null 2>&1; then
  if [ -d .git ]; then
    say "Updating $DIR"
    git fetch --depth 1 origin "$REF" && git checkout -q FETCH_HEAD
  elif [ -z "$(ls -A . 2>/dev/null)" ]; then
    say "Downloading HyperLevel into $DIR"
    git clone --depth 1 --branch "$REF" "$REPO" .
  fi
fi
if [ ! -f docker-compose.yml ]; then
  say "Downloading docker-compose.yml and the Caddy config (no git found)"
  mkdir -p deploy/caddy
  curl -fsSL "$RAW/docker-compose.yml" -o docker-compose.yml
  curl -fsSL "$RAW/deploy/caddy/Caddyfile" -o deploy/caddy/Caddyfile
  curl -fsSL "$RAW/.env.example" -o .env.example
fi

# --- configuration ------------------------------------------------------------------------------------
NEW_PASSWORD=""
if [ -f .env ]; then
  say "Keeping the existing .env"
  DOMAIN="$(grep -E '^PGHL_DOMAIN=' .env | cut -d= -f2- || true)"
else
  DOMAIN="${GOHIGH_DOMAIN:-}"
  while :; do
    DOMAIN="$(ask 'Domain for HyperLevel (DNS must point at this server, e.g. crm.example.com)' "$DOMAIN")"
    DOMAIN="$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z' | sed -E 's#^https?://##; s#/.*$##')"
    valid_domain "$DOMAIN" && break
    [ "$YES" = "1" ] && die "Set GOHIGH_DOMAIN to a valid domain."
    warn "That doesn't look like a domain name."
  done
  EMAIL="${GOHIGH_ADMIN_EMAIL:-}"
  while :; do
    EMAIL="$(ask 'Admin e-mail (your login)' "$EMAIL")"
    valid_email "$EMAIL" && break
    [ "$YES" = "1" ] && die "Set GOHIGH_ADMIN_EMAIL to a valid e-mail address."
    warn "Please enter a valid e-mail address."
  done
  COMPANY="$(ask 'Company name' "${GOHIGH_COMPANY:-My Company}" | tr -d '#"')"
  NEW_PASSWORD="$(rand 20)"
  SECRET="$(rand 64)"
  [ -f .env.example ] || curl -fsSL "$RAW/.env.example" -o .env.example
  umask 077
  sed -e "s#^PGHL_BASE_URL=.*#PGHL_BASE_URL=https://$DOMAIN#" \
      -e "s#^PGHL_DOMAIN=.*#PGHL_DOMAIN=$DOMAIN#" \
      -e "s#^PGHL_ADMIN_EMAIL=.*#PGHL_ADMIN_EMAIL=$(sed_escape "$EMAIL")#" \
      -e "s#^PGHL_ADMIN_PASSWORD=.*#PGHL_ADMIN_PASSWORD=$NEW_PASSWORD#" \
      -e "s#^PGHL_COMPANY_NAME=.*#PGHL_COMPANY_NAME=$(sed_escape "$COMPANY")#" \
      -e "s#^\# PGHL_SECRET=.*#PGHL_SECRET=$SECRET#" \
      .env.example > .env
  say "Wrote $DIR/.env (mode 600)"
fi

# --- start ----------------------------------------------------------------------------------------------
PROFILE=(--profile caddy)
[ "${GOHIGH_NO_CADDY:-0}" = "1" ] && PROFILE=()
say "Pulling the HyperLevel image (falls back to building it from source)"
if ! docker compose pull gohigh 2> /dev/null; then
  [ -f Dockerfile ] || die "No prebuilt image available and no source checkout to build from. Install git and re-run, or set GOHIGH_IMAGE."
  warn "No prebuilt image found – building locally (a few minutes)."
  docker compose build gohigh
fi
docker compose "${PROFILE[@]}" up -d

say "Waiting for HyperLevel to become healthy"
for _ in $(seq 1 60); do
  if docker compose exec -T gohigh node -e "fetch('http://127.0.0.1:4700/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" > /dev/null 2>&1; then OK=1; break; fi
  sleep 2
done
[ "${OK:-0}" = "1" ] || warn "HyperLevel did not answer yet – check: docker compose logs gohigh"

echo
say "HyperLevel is running."
if [ -n "${DOMAIN:-}" ]; then echo "    Open: https://$DOMAIN  (the first HTTPS request may take a few seconds while Caddy gets the certificate)"; fi
if [ -n "$NEW_PASSWORD" ]; then
  echo "    Login: $EMAIL"
  echo "    Password: $NEW_PASSWORD   ← store it in your password manager now; it is also in $DIR/.env"
  echo "    (After the first login you may remove PGHL_ADMIN_PASSWORD from .env – it is only used on the first start.)"
fi
echo "    Update later: cd $DIR && bash scripts/install.sh   ·   Logs: docker compose logs -f gohigh"
