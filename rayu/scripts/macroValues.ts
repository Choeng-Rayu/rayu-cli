// Single source of truth for MACRO.* values. Consumed by scripts/build.ts
// (as `bun build --define`) and scripts/preload.ts (dev/test global).
import pkg from '../package.json' with { type: 'json' }

export const MACRO_VALUES = {
  VERSION: pkg.version,
  BUILD_TIME: '',
  PACKAGE_URL: '@rayu-dev/rayu-cli',
  NATIVE_PACKAGE_URL: '@rayu-dev/rayu-cli',
  FEEDBACK_CHANNEL: 'https://github.com/Choeng-Rayu/rayu-cli/issues',
  ISSUES_EXPLAINER: 'report the issue at https://github.com/Choeng-Rayu/rayu-cli/issues',
  VERSION_CHANGELOG: '',
  // --- Rayu account/login baked config (shipped in dist/rayu.js; no .env on
  // the user's machine). Set these at BUILD time for a release, e.g.:
  //   RAYU_BUILD_OAUTH=true \
  //   RAYU_BUILD_API_URL=https://rayu.example.com/api \
  //   RAYU_BUILD_WEB_URL=https://rayu.example.com bun run build
  // Runtime env vars (USE_RAYU_OAUTH / RAYU_API_URL / RAYU_WEB_URL) still
  // override these for local development.
  //
  // IMPORTANT (feature-gating correctness): the baked default is what the CLI
  // uses when no runtime env var is present. Since loadDotEnv() only reads the
  // .env in the user's CURRENT working directory, a binary run from any other
  // folder would otherwise fall back to this default. We therefore fall back to
  // the BUILD-TIME .env values (Bun auto-loads .env before this runs):
  // RAYU_BUILD_* takes precedence, then the plain USE_RAYU_OAUTH / RAYU_API_URL
  // / RAYU_WEB_URL / RAYU_GATEWAY_URL from .env, then a safe literal. This makes
  // `bun run build` bake the operator's intended config so entitlement gating
  // is active regardless of the directory the CLI is launched from. The runtime
  // env var still overrides (e.g. USE_RAYU_OAUTH=false disables it locally).
  //
  // DEFAULT: on. With no RAYU_BUILD_OAUTH / USE_RAYU_OAUTH present at build, the
  // baked default is 'true' — a fresh build requires Rayu login and shows the
  // hosted provider. Set RAYU_BUILD_OAUTH=false (build) or USE_RAYU_OAUTH=false
  // (runtime) to opt out.
  RAYU_OAUTH_DEFAULT:
    process.env.RAYU_BUILD_OAUTH ?? process.env.USE_RAYU_OAUTH ?? 'true',
  RAYU_API_URL: process.env.RAYU_BUILD_API_URL ?? process.env.RAYU_API_URL ?? 'https://api.rayucode.com/api',
  RAYU_WEB_URL:
    process.env.RAYU_BUILD_WEB_URL ??
    process.env.RAYU_WEB_URL ??
    'https://rayucode.com',
  RAYU_GATEWAY_URL:
    process.env.RAYU_BUILD_GATEWAY_URL ?? process.env.RAYU_GATEWAY_URL ?? 'https://gateway.rayucode.com',
}

// Rayu-owned allowlist of build-gated `feature('FLAG')` macros to ENABLE.
// Consumed by scripts/build.ts as `Bun.build({ features })` — Bun replaces each
// `feature('FLAG')` call with a boolean literal and preserves dead-code
// elimination, so any flag NOT listed here stays stripped from the bundle.
//
// Only self-contained, provider-agnostic features are enabled. Infra-dependent
// flags (KAIROS, COORDINATOR_MODE, AGENT_TRIGGERS, VOICE_MODE, BRIDGE_MODE,
// ULTRAPLAN/CCR, TRANSCRIPT_CLASSIFIER, etc.) are intentionally excluded so they
// remain dead-code-eliminated — they require Anthropic internal infrastructure
// and would not work on rayu's Bedrock/NVIDIA/GenAI providers.
export const ENABLED_FEATURES = [
  'ULTRATHINK', // "ultrathink" keyword → high thinking effort + rainbow highlight
  'TOKEN_BUDGET', // "+500k" / "use 2M tokens" → per-turn output budget tracking
  'BUILTIN_EXPLORE_PLAN_AGENTS', // Explore + Plan built-in subagents (3P default on)
] as const
