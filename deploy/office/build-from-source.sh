#!/usr/bin/env bash
# Builds a browser editor from the upstream source with the patches in patches/ applied, and installs it like install.sh does.
# Only needed while a pinned release has a bug that a patch here fixes – today: the spreadsheet editor (xlsx) 0.3.0 panics on
# wasm32 when a cell is edited ("time not implemented on this platform", std::time::Instant in the engine's commit step), see
# patches/gridcraft-0001-wasm-instant.patch and docs/office.md#bekannte-grenzen. The release's engine (command line) is not affected.
#
#   deploy/office/build-from-source.sh --kind xlsx --web-dir /opt/office/web
#
# Needs: git, a Rust toolchain (rustup, Rust ≥ 1.90) with the wasm32-unknown-unknown target, trunk (`cargo install trunk --locked`;
# it downloads wasm-bindgen and wasm-opt on its first run), about 4 GB of disk and 10–30 minutes on a small server.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
. "$HERE/versions.env"

KIND=""
WEB_DIR="${PGHL_OFFICE_DIR:-}"
REF=""
while [ $# -gt 0 ]; do
  case "$1" in
    --kind) KIND="$2"; shift 2 ;;
    --web-dir) WEB_DIR="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;   # a tag or commit instead of the pinned version's tag
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unbekannte Option: $1" >&2; exit 1 ;;
  esac
done
case "$KIND" in docx|xlsx|pptx|pdf) ;; *) echo "--kind docx|xlsx|pptx|pdf fehlt" >&2; exit 1 ;; esac
[ -n "$WEB_DIR" ] || { echo "--web-dir (oder PGHL_OFFICE_DIR) fehlt" >&2; exit 1; }
for tool in git cargo rustup trunk; do command -v "$tool" >/dev/null || { echo "$tool fehlt (siehe Kopf dieses Skripts)" >&2; exit 1; }; done

K="$(echo "$KIND" | tr '[:lower:]' '[:upper:]')"
repo_var="OFFICE_${K}_REPO"; name_var="OFFICE_${K}_NAME"; ver_var="OFFICE_${K}_VERSION"
REPO="${!repo_var}"; NAME="${!name_var}"; VER="${!ver_var}"
REF="${REF:-v$VER}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git clone --quiet --depth 1 --branch "$REF" "$OFFICE_GITHUB/$REPO.git" "$WORK/src"
shopt -s nullglob
for p in "$HERE"/patches/"$NAME"-*.patch; do
  echo "→ Patch $(basename "$p")"
  git -C "$WORK/src" apply --check "$p" && git -C "$WORK/src" apply "$p"
done
rustup target add wasm32-unknown-unknown >/dev/null
(cd "$WORK/src/apps/$NAME-web" && trunk build --release --dist "$WORK/site" --public-url ./)
[ -f "$WORK/site/index.html" ] || { echo "Build ohne index.html" >&2; exit 1; }
cp "$WORK/src/LICENSE-MIT" "$WORK/src/LICENSE-APACHE" "$WORK/site/" 2>/dev/null || true
for f in "$WORK/site"/*.wasm "$WORK/site"/*.js; do
  if command -v gzip >/dev/null; then gzip -9 -k -f "$f" && touch -r "$f" "$f.gz"; fi
  if command -v brotli >/dev/null; then brotli -q 11 -k -f "$f" && touch -r "$f" "$f.br"; fi
done
printf '%s %s (aus dem Quelltext, %s, Patches: %s)\n' "$NAME-web" "$VER" "$REF" "$(cd "$HERE/patches" && ls "$NAME"-*.patch 2>/dev/null | tr '\n' ' ')" > "$WORK/site/VERSION.txt"
mkdir -p "$WEB_DIR"
rm -rf "$WEB_DIR/$KIND.new" "$WEB_DIR/$KIND.old"
cp -R "$WORK/site" "$WEB_DIR/$KIND.new"
[ -d "$WEB_DIR/$KIND" ] && mv "$WEB_DIR/$KIND" "$WEB_DIR/$KIND.old"
mv "$WEB_DIR/$KIND.new" "$WEB_DIR/$KIND"
rm -rf "$WEB_DIR/$KIND.old"
echo "Editor $KIND (aus dem Quelltext) → $WEB_DIR/$KIND"
