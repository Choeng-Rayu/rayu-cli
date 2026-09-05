#!/bin/sh
# Verify this repo's installer scripts match what rayucode.com actually serves.
#
# The scripts exist in two repositories: rayu-web/public/install.{sh,ps1} (the
# canonical copies, served at /install, /install.sh and /install.ps1) and
# rayu/install.{sh,ps1} here (used by `./install.sh --local` and referenced by
# documentations/13-binaries.md). Nothing in either repo's CI can diff across
# that boundary, so this script diffs against the live site instead — the only
# comparison that actually answers "is what users download the same script we
# reviewed?".
#
#   bun run check:installer
#   RAYU_WEB_ORIGIN=http://localhost:3000 bun run check:installer   # pre-deploy
#
# Exit 0 when both match, 1 on any difference, 2 when the site is unreachable
# (so a flaky network is distinguishable from a real drift).
set -eu

ORIGIN="${RAYU_WEB_ORIGIN:-https://rayucode.com}"
SCRIPT_DIR=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

status=0

check() {
  local_file="$SCRIPT_DIR/$1"
  url="$ORIGIN/$2"

  if [ ! -f "$local_file" ]; then
    echo "MISSING  $local_file" >&2
    status=1
    return
  fi

  if ! curl -fsSL --retry 2 --connect-timeout 20 "$url" -o "$TMP/$1" 2>/dev/null; then
    echo "UNREACHABLE  $url (skipped)" >&2
    # Only downgrade a clean run to "unreachable"; never mask a real DRIFT.
    # Written as a full `if` on purpose: `[ … ] && status=2` is a failing
    # AND-list once status is already 2, which `set -e` turns into exit 1.
    if [ "$status" -eq 0 ]; then
      status=2
    fi
    return
  fi

  if cmp -s "$local_file" "$TMP/$1"; then
    echo "OK       $1 matches $url"
  else
    echo "DRIFT    $1 differs from $url" >&2
    diff -u "$TMP/$1" "$local_file" | head -40 >&2 || true
    echo "" >&2
    echo "Fix: copy the intended version over the other, in one change:" >&2
    echo "  cp <rayu-web>/public/$1 $local_file    # take the served copy" >&2
    echo "  cp $local_file <rayu-web>/public/$1    # publish this copy" >&2
    status=1
  fi
}

command -v curl >/dev/null 2>&1 || { echo "need curl" >&2; exit 2; }

check install.sh install.sh
check install.ps1 install.ps1

exit "$status"
