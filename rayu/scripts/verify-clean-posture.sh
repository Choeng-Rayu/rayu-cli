#!/usr/bin/env bash
# Rayu-CLI clean-posture verification — one command that proves the de-brand /
# de-risk posture: build + typecheck + de-risk test suites + origin-manifest
# coverage + bundle greps. Exits non-zero if any hard gate fails.
#
# Usage:  bash scripts/verify-clean-posture.sh
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=1; }

step "Build"
if bun run build >/dev/null 2>&1; then ok "dist/rayu.js built"; else bad "build failed"; fi

step "Typecheck (no new errors vs baseline)"
if bun run typecheck:ci >/dev/null 2>&1; then ok "no new type errors"; else bad "typecheck introduced new errors"; fi

step "Origin manifest coverage"
if bun run scripts/origin-manifest.ts --check >/dev/null 2>&1; then ok "every src file classified; manifest current"; else bad "origin manifest stale/incomplete"; fi

step "De-brand / de-risk invariant tests"
DERISK_TESTS="test/rebrand.test.ts test/networkGuard.test.ts test/envAliases.test.ts test/analyticsEventLogging.test.ts test/claudeAiOAuthDisabled.test.ts test/remoteSessionDeClaudeAi.test.ts test/originManifest.test.ts test/cleanPosture.test.ts"
if bun test $DERISK_TESTS >/dev/null 2>&1; then ok "all de-risk invariants green"; else bad "a de-risk invariant test failed"; fi

step "Brand identity"
VER="$(node dist/rayu.js --version 2>/dev/null)"
if printf '%s' "$VER" | grep -q "Rayu-CLI" && ! printf '%s' "$VER" | grep -qi "claude"; then
  ok "--version = $VER"
else
  bad "--version not Rayu-branded: $VER"
fi

step "Bundle: Anthropic telemetry SDK absent"
if ! grep -q "@growthbook/growthbook" dist/rayu.js; then ok "no @growthbook/growthbook in dist/rayu.js"; else bad "@growthbook present in bundle"; fi

step "Remote-session host de-pointed from claude.ai (constants/product.ts)"
# Task 8 de-pointed the remote-session base URL to an env-driven Rayu host.
# (A dead, ant-only staging OAuth-config string remains in constants/oauth.ts
# behind the disabled login — tracked as a follow-up, not a live endpoint.)
if ! grep -Eq "claude\.ai|ant\.dev" src/constants/product.ts; then
  ok "product.ts has no hardcoded claude.ai / ant.dev URL"
else
  bad "product.ts still hardcodes a claude.ai / ant.dev URL"
fi

printf '\n'
if [ "$fail" -eq 0 ]; then
  printf '\033[32m✓ CLEAN POSTURE VERIFIED\033[0m — Rayu-branded, telemetry-neutralized, claude.ai-login-free.\n'
  printf 'Note: the Anthropic *provider* (api.anthropic.com) remains for BYO ANTHROPIC_API_KEY use — intentional.\n'
  exit 0
else
  printf '\033[31m✗ CLEAN POSTURE CHECK FAILED\033[0m — see FAIL lines above.\n'
  exit 1
fi
