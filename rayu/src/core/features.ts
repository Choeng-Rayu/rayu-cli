/**
 * Build-gated feature flags, portably.
 *
 * WHY THIS IS NOT SIMPLY `feature()` FROM `bun:bundle`
 *
 * `bun:bundle` is a Bun-bundler virtual module. It cannot be imported under the
 * plain Node runtime the VS Code extension uses, so nothing in core may touch
 * it. But it cannot simply be replaced by a runtime function either, because
 * Bun's `features:` build option is load-bearing for the CLI: of the 89 flags
 * referenced in rayu/src, only 4 are enabled, and Bun dead-code-eliminates the
 * other 85 branches — including their dynamic `import()`s, so whole subsystems
 * never reach dist/rayu.js. Several source comments call `feature()` a
 * "tree-shaking boundary" for exactly this reason.
 *
 * Measured, not assumed (see RAYU_CORE_MIGRATION_PLAN.md Task 4):
 *   - `import { feature } from 'bun:bundle'` + `feature('X')`  → DCE works.
 *   - the same call reached through ANY re-export indirection  → DCE BREAKS;
 *     the disabled branch and its `feature(` call both survive.
 *   - a member expression `RAYU_FEATURES.X` with a matching `--define`
 *                                                              → DCE works,
 *     disabled branches and their dynamic imports are dropped, and no
 *     `RAYU_FEATURES.` reference remains in the output.
 *
 * So the call sites become `RAYU_FEATURES.<FLAG>` — the same mechanism `MACRO.*`
 * already uses in this repo. Three runtimes are then satisfied:
 *
 *   - built CLI:   `rayu/scripts/build.ts` `--define`s every flag to a boolean
 *                  literal, so Bun evaluates and eliminates exactly as before;
 *   - bun dev/test: no define runs, so `scripts/preload.ts` installs
 *                  `globalThis.RAYU_FEATURES`;
 *   - extension:   core's own code calls {@link isFeatureEnabled}, which reads
 *                  the same global and defaults to disabled.
 */

/**
 * The flags Rayu ships ENABLED. Single source of truth: consumed by
 * `rayu/scripts/build.ts` (as `Bun.build({ features })` and to generate the
 * `FEATURES.*` defines) and re-exported by `rayu/scripts/macroValues.ts`.
 *
 * Only self-contained, provider-agnostic features are enabled. Infra-dependent
 * flags (KAIROS, COORDINATOR_MODE, AGENT_TRIGGERS, VOICE_MODE, BRIDGE_MODE,
 * ULTRAPLAN/CCR, TRANSCRIPT_CLASSIFIER, …) are intentionally excluded so they
 * stay dead-code-eliminated — they require Anthropic internal infrastructure and
 * would not work on rayu's Bedrock/NVIDIA/GenAI providers.
 */
export const ENABLED_FEATURES = [
  'ULTRATHINK', // "ultrathink" keyword → high thinking effort + rainbow highlight
  'TOKEN_BUDGET', // "+500k" / "use 2M tokens" → per-turn output budget tracking
  'BUILTIN_EXPLORE_PLAN_AGENTS', // Explore + Plan built-in subagents (3P default on)
  'EXTERNAL_AGENTS', // /agent + ExternalAgent tool: orchestrate Codex / Claude Code / OpenCode / ACP CLIs
] as const

export type EnabledFeature = (typeof ENABLED_FEATURES)[number]

/** A flag name → enabled mapping, as installed on `globalThis.RAYU_FEATURES`. */
export type FeatureTable = Readonly<Record<string, boolean>>

/**
 * Build a complete table from the full flag inventory.
 *
 * Every known flag gets an explicit entry, including the disabled ones: a
 * missing entry would leave `RAYU_FEATURES.X` undefined, which is falsy and so
 * behaves correctly, but would also leave the property access in the bundle
 * instead of a literal and defeat elimination.
 */
export function buildFeatureTable(
  allFlags: readonly string[],
  enabled: readonly string[] = ENABLED_FEATURES,
): Record<string, boolean> {
  const enabledSet = new Set(enabled)
  const table: Record<string, boolean> = {}
  for (const flag of allFlags) table[flag] = enabledSet.has(flag)
  return table
}

/**
 * Install the table for runtimes with no bundler `--define` step.
 *
 * The only reader is `rayu/src` itself, through the ambient `RAYU_FEATURES.FLAG`
 * member expressions the Task 4 codemod produced — which is deliberate: a member
 * expression is what Bun can substitute with a literal and eliminate, and a
 * function call is not. So there is no accompanying getter here; adding one would
 * invite call sites that defeat dead-code elimination.
 */
export function installFeatureTable(table: FeatureTable): void {
  ;(globalThis as { RAYU_FEATURES?: FeatureTable }).RAYU_FEATURES = table
}
