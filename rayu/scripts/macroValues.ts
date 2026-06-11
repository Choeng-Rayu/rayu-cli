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
