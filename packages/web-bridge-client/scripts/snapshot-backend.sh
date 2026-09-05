#!/usr/bin/env bash
#
# Regenerate test/fixtures/backend-web-bridge.types.snapshot.ts from the live
# rayu-backend source.
#
# Run this when the Web Bridge protocol changes. The resulting diff IS the protocol
# change under review, which is why the snapshot contains only the constant
# declarations: a copy of the whole backend file would churn on every prose edit over
# there and train reviewers to rubber-stamp the one diff that is meant to be
# load-bearing.
#
# Point RAYU_BACKEND_DIR at the backend checkout if it is not a sibling of rayu-cli.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg="$(dirname "$here")"

backend_dir="${RAYU_BACKEND_DIR:-}"
if [[ -z "$backend_dir" ]]; then
  for candidate in \
    "$pkg/../../../rayucode/rayu-backend" \
    "$pkg/../../rayucode/rayu-backend"; do
    if [[ -d "$candidate" ]]; then
      backend_dir="$candidate"
      break
    fi
  done
fi

src="$backend_dir/src/web-bridge/web-bridge.types.ts"
if [[ ! -f "$src" ]]; then
  echo "error: cannot find web-bridge.types.ts. Set RAYU_BACKEND_DIR." >&2
  exit 1
fi

dst="$pkg/test/fixtures/backend-web-bridge.types.snapshot.ts"
mkdir -p "$(dirname "$dst")"

{
  cat <<'HEADER'
/**
 * SNAPSHOT — do not edit by hand.
 *
 * A verbatim copy of the constant declarations in
 * rayu-backend/src/web-bridge/web-bridge.types.ts.
 *
 * It exists so test/protocolParity.test.ts asserts something meaningful in a clone
 * that does not have rayu-backend checked out beside it. When the protocol changes,
 * regenerate this file and the diff IS the protocol change under review.
 *
 * Regenerate with:
 *   npm run snapshot:backend --workspace @rayu-dev/web-bridge-client
 *
 * Never imported by src/. Read as text by the test, exactly as the live backend file
 * is, so both paths exercise the same parser.
 */

HEADER
  grep -E "^export const (WEB_BRIDGE_WS_PATH|BROWSER_NAMESPACE|CLI_NAMESPACE|MAX_[A-Z_]+|HISTORY_[A-Z_]+)" "$src"
  echo
  awk '/^export const (BROWSER_EVENT|BROWSER_COMMAND|CLI_EVENT|CLI_COMMAND) = \{/,/^\} as const/' "$src" \
    | grep -vE "^\s*(/\*|\*|//)" | grep -v "^\s*$"
} > "$dst"

echo "wrote $dst"
