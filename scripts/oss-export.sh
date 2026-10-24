#!/usr/bin/env bash
# Clean export of HEAD for the first public commit – a fresh history without the private past.
#
#   scripts/oss-export.sh                    # → oss-export/gohigh-<version>/ + .tar.gz, checked
#   scripts/oss-export.sh --init             # … and a new git repository with ONE commit, ready to push
#   scripts/oss-export.sh --out /tmp/x --denylist ~/private-terms.txt
#
# What it does:
#   1. git archive of HEAD (tracked files only – nothing untracked, no .git history; paths marked
#      export-ignore in .gitattributes are left out),
#   2. scripts/oss-check.mjs on the result: secrets, public IPs, forbidden files (.env, databases,
#      keystores), required community files, and your private denylist (.oss-denylist / OSS_DENYLIST /
#      --denylist – never committed),
#   3. optionally `git init` + one commit (author: OSS_AUTHOR_NAME / OSS_AUTHOR_EMAIL).
# Any finding aborts with exit code 1 and leaves nothing half-done behind.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git rev-parse --show-toplevel)"
cd "$REPO"

OUT=""
INIT=0
DENY=""
ALLOW_DIRTY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --init) INIT=1; shift ;;
    --denylist) DENY="$2"; shift 2 ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo 0.0.0)"
NAME="$(node -p "require('./package.json').name" 2>/dev/null || basename "$REPO")"
OUT="${OUT:-$REPO/oss-export/$NAME-$VERSION}"

if [ "$ALLOW_DIRTY" = "0" ] && [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Uncommitted changes – the export contains HEAD only. Commit first, or pass --allow-dirty." >&2
  exit 1
fi
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
  echo "$OUT exists and is not empty – remove it or choose --out." >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "==> Exporting $(git rev-parse --short HEAD) ($NAME $VERSION)"
git archive --format=tar HEAD | tar -x -C "$TMP"

echo "==> Checking the export"
CHECK=(node "$SCRIPT_DIR/oss-check.mjs" --dir "$TMP" --require-files)
[ -n "$DENY" ] && CHECK+=(--denylist "$DENY")
if ! "${CHECK[@]}"; then
  echo "Export NOT created – fix the findings above (or mark a fake test value with 'oss-check: allow')." >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
mv "$TMP" "$OUT"
trap - EXIT
tar -czf "$OUT.tar.gz" -C "$(dirname "$OUT")" "$(basename "$OUT")"
echo "==> Export ready: $OUT (+ $OUT.tar.gz)"

if [ "$INIT" = "1" ]; then
  AUTHOR_NAME="${OSS_AUTHOR_NAME:-HyperLevel Maintainers}"
  AUTHOR_EMAIL="${OSS_AUTHOR_EMAIL:-maintainers@users.noreply.github.com}"
  (
    cd "$OUT"
    git init -q -b main
    git add -A
    GIT_AUTHOR_NAME="$AUTHOR_NAME" GIT_AUTHOR_EMAIL="$AUTHOR_EMAIL" GIT_COMMITTER_NAME="$AUTHOR_NAME" GIT_COMMITTER_EMAIL="$AUTHOR_EMAIL" \
      git -c commit.gpgsign=false commit -q -m "HyperLevel $VERSION – initial public release"
  )
  echo "==> Fresh repository with one commit in $OUT"
  echo "    Next: cd $OUT && git remote add origin git@github.com:BAISESYSTEMS/GoHyperLevel.git && git push -u origin main && git tag v$VERSION && git push origin v$VERSION"
fi
