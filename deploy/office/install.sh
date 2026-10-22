#!/usr/bin/env bash
# Installs the optional Office engines (headless command-line programs) and browser editors (static WebAssembly sites) for
# HyperLevel's Office area from the pinned upstream releases in versions.env – downloaded from GitHub, checked against the pinned
# sha256, unpacked. Nothing of it is part of HyperLevel's repository or image; see docs/office.md and THIRD-PARTY.md.
#
#   deploy/office/install.sh --web-dir /opt/office/web --bin-dir /opt/office/bin
#   deploy/office/install.sh --only bin --bin-dir /opt/office/bin      # engines only (agent reads/edits, PDF export)
#   deploy/office/install.sh --only web --web-dir /opt/office/web --kinds docx,pdf
#
# Then: PGHL_OFFICE_DIR=/opt/office/web PGHL_OFFICE_BIN_DIR=/opt/office/bin (HyperLevel reads them at every call – no restart needed).
#
# Needs: bash, curl, unzip, tar, sha256sum (or shasum); optional gzip/brotli (precompressed .gz/.br next to the large files,
# HyperLevel serves them when the browser accepts them). Linux x86_64 or aarch64 for the engines (glibc ≥ 2.35 – Debian 12,
# Ubuntu 22.04 or newer; not Alpine/musl, see the Dockerfile).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
. "$HERE/versions.env"

WEB_DIR="${PGHL_OFFICE_DIR:-}"
BIN_DIR="${PGHL_OFFICE_BIN_DIR:-}"
ONLY=""
KINDS="docx,xlsx,pptx,pdf"
ARCH="$(uname -m)"

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --web-dir) WEB_DIR="$2"; shift 2 ;;
    --bin-dir) BIN_DIR="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --kinds) KINDS="$2"; shift 2 ;;
    --arch) ARCH="$2"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "unbekannte Option: $1" >&2; usage 1 ;;
  esac
done
case "$ARCH" in x86_64|amd64) ARCH=x86_64 ;; aarch64|arm64) ARCH=aarch64 ;; *) echo "Architektur $ARCH wird von den Engines nicht angeboten (x86_64, aarch64)" >&2; exit 1 ;; esac
[ "$ONLY" = "bin" ] || [ -n "$WEB_DIR" ] || { echo "--web-dir (oder PGHL_OFFICE_DIR) fehlt" >&2; exit 1; }
[ "$ONLY" = "web" ] || [ -n "$BIN_DIR" ] || { echo "--bin-dir (oder PGHL_OFFICE_BIN_DIR) fehlt" >&2; exit 1; }
for tool in curl unzip tar; do command -v "$tool" >/dev/null || { echo "$tool fehlt" >&2; exit 1; }; done

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# fetch URL FILE EXPECTED_SHA256
fetch() {
  local url="$1" out="$2" want="$3"
  if [ -z "$want" ] && [ "${OFFICE_ALLOW_UNPINNED:-}" != "1" ]; then
    echo "Keine Prüfsumme für $url in versions.env – Abbruch (OFFICE_ALLOW_UNPINNED=1 erzwingt es)" >&2
    exit 1
  fi
  echo "→ $url"
  # https only for GitHub; a mirror in OFFICE_GITHUB (e.g. an internal one) may use plain http – the checksum still applies
  if [[ "$url" == https://* ]]; then curl -fsSL --retry 3 --proto '=https' --tlsv1.2 -o "$out" "$url"; else curl -fsSL --retry 3 -o "$out" "$url"; fi
  local got
  got="$(sha256 "$out")"
  if [ -n "$want" ] && [ "$got" != "$want" ]; then
    echo "Prüfsumme stimmt nicht: $url (erwartet $want, erhalten $got)" >&2
    exit 1
  fi
}

# precompress DIR: .gz/.br next to the big text and wasm files, with the same mtime (HyperLevel ignores stale siblings)
precompress() {
  local f
  for f in "$1"/*.wasm "$1"/*.js; do
    [ -f "$f" ] || continue
    if command -v gzip >/dev/null; then gzip -9 -k -f "$f" && touch -r "$f" "$f.gz"; fi
    if command -v brotli >/dev/null; then brotli -q 11 -k -f "$f" && touch -r "$f" "$f.br"; fi
  done
}

install_web() {
  local kind="$1" name="$2" ver="$3" repo="$4" sum="$5"
  local zip="$WORK/$name-web.zip" un="$WORK/$name-web"
  fetch "$OFFICE_GITHUB/$repo/releases/download/v$ver/$name-web-$ver.zip" "$zip" "$sum"
  rm -rf "$un" && mkdir -p "$un"
  unzip -q "$zip" -d "$un"
  # the zip holds one folder <name>-web-<ver>/
  local site="$un/$name-web-$ver"
  [ -f "$site/index.html" ] || site="$(dirname "$(find "$un" -maxdepth 2 -name index.html | head -n1)")"
  [ -f "$site/index.html" ] || { echo "$name-web-$ver.zip enthält keine index.html" >&2; exit 1; }
  rm -f "$site/.htaccess" "$site/_headers"
  precompress "$site"
  mkdir -p "$WEB_DIR"
  rm -rf "$WEB_DIR/$kind.new" "$WEB_DIR/$kind.old"
  cp -R "$site" "$WEB_DIR/$kind.new"
  printf '%s %s\n' "$name-web" "$ver" > "$WEB_DIR/$kind.new/VERSION.txt"
  # swap in one step: a running HyperLevel never serves a half-copied editor
  [ -d "$WEB_DIR/$kind" ] && mv "$WEB_DIR/$kind" "$WEB_DIR/$kind.old"
  mv "$WEB_DIR/$kind.new" "$WEB_DIR/$kind"
  rm -rf "$WEB_DIR/$kind.old"
  echo "  Editor $kind → $WEB_DIR/$kind"
}

install_bin() {
  local kind="$1" name="$2" ver="$3" repo="$4" sum="$5"
  local tgz="$WORK/$name-linux.tar.gz" base="$name-$ver-linux-$ARCH"
  fetch "$OFFICE_GITHUB/$repo/releases/download/v$ver/$base.tar.gz" "$tgz" "$sum"
  tar -xzf "$tgz" -C "$WORK" "$base/bin/$name-cli" "$base/share/doc/$name"
  mkdir -p "$BIN_DIR" "$BIN_DIR/licenses/$kind"
  install -m 0755 "$WORK/$base/bin/$name-cli" "$BIN_DIR/$name-cli.new"
  mv -f "$BIN_DIR/$name-cli.new" "$BIN_DIR/$name-cli"
  cp "$WORK/$base/share/doc/$name"/LICENSE-* "$BIN_DIR/licenses/$kind/" 2>/dev/null || true
  "$BIN_DIR/$name-cli" --version >/dev/null 2>&1 || echo "  Achtung: $name-cli startet hier nicht (glibc ≥ 2.35 nötig)" >&2
  echo "  Engine $kind → $BIN_DIR/$name-cli"
}

IFS=',' read -r -a WANT <<< "$KINDS"
for kind in "${WANT[@]}"; do
  K="$(echo "$kind" | tr '[:lower:]' '[:upper:]')"
  case "$kind" in docx|xlsx|pptx|pdf) ;; *) echo "unbekannte Art: $kind (docx, xlsx, pptx, pdf)" >&2; exit 1 ;; esac
  repo_var="OFFICE_${K}_REPO"; name_var="OFFICE_${K}_NAME"; ver_var="OFFICE_${K}_VERSION"; web_var="OFFICE_${K}_WEB_SHA256"
  bin_var="OFFICE_${K}_LINUX_$(echo "$ARCH" | tr '[:lower:]' '[:upper:]')_SHA256"
  [ "$ONLY" = "bin" ] || install_web "$kind" "${!name_var}" "${!ver_var}" "${!repo_var}" "${!web_var:-}"
  [ "$ONLY" = "web" ] || install_bin "$kind" "${!name_var}" "${!ver_var}" "${!repo_var}" "${!bin_var:-}"
done
echo "Fertig. PGHL_OFFICE_DIR=${WEB_DIR:-(nicht gesetzt)} PGHL_OFFICE_BIN_DIR=${BIN_DIR:-(nicht gesetzt)}"
