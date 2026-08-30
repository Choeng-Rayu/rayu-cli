/**
 * Build- and run-time gate for the external-agent orchestrator.
 *
 * Every entry point into `src/externalAgents/` must be reached through a
 * `feature('EXTERNAL_AGENTS')` guard so the whole subsystem is dead-code
 * eliminated from builds that do not ship it. `EXTERNAL_AGENTS` is intentionally
 * absent from `ENABLED_FEATURES` in `scripts/macroValues.ts` until the
 * subsystem is complete.
 *
 * Callers that need the modules themselves must use the gated `require()`
 * pattern already used by `src/tools.ts`:
 *
 *     const ExternalAgentTool = feature('EXTERNAL_AGENTS')
 *       ? require('./tools/ExternalAgentTool/ExternalAgentTool.js').ExternalAgentTool
 *       : null
 *
 * Do NOT convert those to static `import` — a static import defeats the
 * elimination and pulls the entire subsystem into every bundle.
 */

import { feature } from 'bun:bundle'
import { isEnvDefinedFalsy } from '../utils/envUtils.js'

/**
 * Env kill-switch, honoured only in builds where the feature is compiled in.
 *
 * This subsystem spawns third-party processes that inherit real credentials, so
 * an operator needs a way to turn it off without downgrading the binary.
 */
const DISABLE_ENV_VAR = 'RAYU_EXTERNAL_AGENTS'

/**
 * True when the external-agent orchestrator is available in this build and has
 * not been switched off for this process.
 *
 * Uses the positive-ternary gating pattern (see `src/bridge/bridgeEnabled.ts`):
 * a negative guard such as `if (!feature(...)) return false` does NOT eliminate
 * the referenced literals and imports from external builds.
 */
export function isExternalAgentsEnabled(): boolean {
  return feature('EXTERNAL_AGENTS')
    ? !isEnvDefinedFalsy(process.env[DISABLE_ENV_VAR])
    : false
}

/**
 * Human-readable reason the subsystem is unavailable, or null when it is
 * available. Commands surface this instead of failing opaquely.
 */
export function getExternalAgentsDisabledReason(): string | null {
  if (!feature('EXTERNAL_AGENTS')) {
    return 'External agent orchestration is not available in this build.'
  }
  return isEnvDefinedFalsy(process.env[DISABLE_ENV_VAR])
    ? `External agent orchestration is disabled by ${DISABLE_ENV_VAR}.`
    : null
}
