import { feature } from 'bun:bundle'
import {
  checkGate_CACHED_OR_BLOCKING,
  getDynamicConfig_CACHED_MAY_BE_STALE,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from '../services/analytics/growthbook.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { lt } from '../utils/semver.js'

/**
 * Runtime check for bridge mode entitlement.
 *
 * Remote Control previously depended on Claude account OAuth. Rayu does not
 * support that auth path, so this feature is disabled until a Rayu-owned remote
 * entitlement exists.
 *
 * The `feature('BRIDGE_MODE')` guard ensures the GrowthBook string literal
 * is only referenced when bridge mode is enabled at build time.
 */
export function isBridgeEnabled(): boolean {
  // Positive ternary pattern — see docs/feature-gating.md.
  // Negative pattern (if (!feature(...)) return) does not eliminate
  // inline string literals from external builds.
  return feature('BRIDGE_MODE')
    ? false && getFeatureValue_CACHED_MAY_BE_STALE('tengu_ccr_bridge', false)
    : false
}

/**
 * Blocking entitlement check for Remote Control.
 *
 * Returns cached `true` immediately (fast path). If the disk cache says
 * `false` or is missing, awaits GrowthBook init and fetches the fresh
 * server value (slow path, max ~5s), then writes it to disk.
 *
 * Use at entitlement gates where a stale `false` would unfairly block access.
 * For user-facing error paths, prefer `getBridgeDisabledReason()` which gives
 * a specific diagnostic. For render-body UI visibility checks, use
 * `isBridgeEnabled()` instead.
 */
export async function isBridgeEnabledBlocking(): Promise<boolean> {
  return feature('BRIDGE_MODE')
    ? false && (await checkGate_CACHED_OR_BLOCKING('tengu_ccr_bridge'))
    : false
}

/**
 * Diagnostic message for why Remote Control is unavailable, or null if
 * it's enabled. Call this instead of a bare `isBridgeEnabledBlocking()`
 * check when you need to show the user an actionable error.
 *
 * Rayu does not expose Claude-account login recovery paths.
 */
export async function getBridgeDisabledReason(): Promise<string | null> {
  if (feature('BRIDGE_MODE')) {
    void (await checkGate_CACHED_OR_BLOCKING('tengu_ccr_bridge'))
    return 'Remote Control is disabled in Rayu unless backed by Rayu-owned remote configuration.'
  }
  return 'Remote Control is not available in this build.'
}

/**
 * Runtime check for the env-less (v2) REPL bridge path.
 * Returns true when the GrowthBook flag `tengu_bridge_repl_v2` is enabled.
 *
 * This gates which implementation initReplBridge uses — NOT whether bridge
 * is available at all (see isBridgeEnabled above). Daemon/print paths stay
 * on the env-based implementation regardless of this gate.
 */
export function isEnvLessBridgeEnabled(): boolean {
  return feature('BRIDGE_MODE')
    ? getFeatureValue_CACHED_MAY_BE_STALE('tengu_bridge_repl_v2', false)
    : false
}

/**
 * Kill-switch for the `cse_*` → `session_*` client-side retag shim.
 *
 * The shim exists because compat/convert.go:27 validates TagSession and the
 * claude.ai frontend routes on `session_*`, while v2 worker endpoints hand out
 * `cse_*`. Once the server tags by environment_kind and the frontend accepts
 * `cse_*` directly, flip this to false to make toCompatSessionId a no-op.
 * Defaults to true — the shim stays active until explicitly disabled.
 */
export function isCseShimEnabled(): boolean {
  return feature('BRIDGE_MODE')
    ? getFeatureValue_CACHED_MAY_BE_STALE(
        'tengu_bridge_repl_v2_cse_shim_enabled',
        true,
      )
    : true
}

/**
 * Returns an error message if the current CLI version is below the
 * minimum required for the v1 (env-based) Remote Control path, or null if the
 * version is fine. The v2 (env-less) path uses checkEnvLessBridgeMinVersion()
 * in envLessBridgeConfig.ts instead — the two implementations have independent
 * version floors.
 *
 * Uses cached (non-blocking) GrowthBook config. If GrowthBook hasn't
 * loaded yet, the default '0.0.0' means the check passes — a safe fallback.
 */
export function checkBridgeMinVersion(): string | null {
  // Positive pattern — see docs/feature-gating.md.
  // Negative pattern (if (!feature(...)) return) does not eliminate
  // inline string literals from external builds.
  if (feature('BRIDGE_MODE')) {
    const config = getDynamicConfig_CACHED_MAY_BE_STALE<{
      minVersion: string
    }>('tengu_bridge_min_version', { minVersion: '0.0.0' })
    if (config.minVersion && lt(MACRO.VERSION, config.minVersion)) {
      return `Your version of RAYU (${MACRO.VERSION}) is too old for Remote Control.\nVersion ${config.minVersion} or higher is required. Run \`claude update\` to update.`
    }
  }
  return null
}

/**
 * Default for remoteControlAtStartup when the user hasn't explicitly set it.
 * When the CCR_AUTO_CONNECT build flag is present (ant-only) and the
 * tengu_cobalt_harbor GrowthBook gate is on, all sessions connect to CCR by
 * default — the user can still opt out by setting remoteControlAtStartup=false
 * in config (explicit settings always win over this default).
 *
 * Defined here rather than in config.ts to avoid a direct
 * config.ts → growthbook.ts import cycle (growthbook.ts → user.ts → config.ts).
 */
export function getCcrAutoConnectDefault(): boolean {
  return feature('CCR_AUTO_CONNECT')
    ? getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_harbor', false)
    : false
}

/**
 * Opt-in CCR mirror mode — every local session spawns an outbound-only
 * Remote Control session that receives forwarded events. Separate from
 * getCcrAutoConnectDefault (bidirectional Remote Control). Env var wins for
 * local opt-in; GrowthBook controls rollout.
 */
export function isCcrMirrorEnabled(): boolean {
  return feature('CCR_MIRROR')
    ? isEnvTruthy(process.env.CLAUDE_CODE_CCR_MIRROR) ||
        getFeatureValue_CACHED_MAY_BE_STALE('tengu_ccr_mirror', false)
    : false
}
