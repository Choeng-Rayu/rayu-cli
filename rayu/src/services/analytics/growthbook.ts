// ─────────────────────────────────────────────────────────────────────────────
// Analytics gate module — NEUTRALIZED STUB (Rayu de-risk).
//
// Upstream, this module wrapped Anthropic's GrowthBook + Statsig feature-flag
// and experiment-exposure service: it constructed a GrowthBook client, fetched
// remote-eval feature payloads over the network, cached them in the user's
// config, and logged experiment exposures to the first-party event pipeline.
// None of that infrastructure belongs in Rayu.
//
// This stub preserves the EXACT public API (every export + signature) so the
// ~250 call sites across the codebase keep compiling and behaving, but it:
//   • imports no `@growthbook/growthbook` SDK,
//   • makes zero network calls, starts no timers, registers no exit handlers,
//   • logs no telemetry / experiment exposures,
//   • returns each caller's own default for feature values and `false` for
//     gates — exactly what the original returned when the flag service was
//     unavailable or disabled.
//
// The original implementation is preserved for reference at
// un-use-code/services/analytics/growthbook.original.ts (excluded from build).
// ─────────────────────────────────────────────────────────────────────────────

import type { GitHubActionsMetadata } from '../../utils/user.js'

/**
 * User attributes shape, retained for API/type compatibility with callers that
 * still reference the type. No values are ever collected or transmitted.
 */
export type GrowthBookUserAttributes = {
  id: string
  sessionId: string
  deviceID: string
  platform: 'win32' | 'darwin' | 'linux'
  apiBaseUrlHost?: string
  organizationUUID?: string
  accountUUID?: string
  userType?: string
  subscriptionType?: string
  rateLimitTier?: string
  firstTokenTime?: number
  email?: string
  appVersion?: string
  github?: GitHubActionsMetadata
}

/**
 * Register a refresh listener. There is never a remote refresh in the stub, so
 * the listener is never invoked; a no-op unsubscribe preserves the contract.
 */
export function onGrowthBookRefresh(
  _listener: () => void | Promise<void>,
): () => void {
  return () => {}
}

/** No env-var feature overrides in the stub. */
export function hasGrowthBookEnvOverride(_feature: string): boolean {
  return false
}

/** No known features in the stub. */
export function getAllGrowthBookFeatures(): Record<string, unknown> {
  return {}
}

/** No config overrides in the stub. */
export function getGrowthBookConfigOverrides(): Record<string, unknown> {
  return {}
}

/** No-op: config overrides are not supported in the stub. */
export function setGrowthBookConfigOverride(
  _feature: string,
  _value: unknown,
): void {}

/** No-op: config overrides are not supported in the stub. */
export function clearGrowthBookConfigOverrides(): void {}

/**
 * Hostname of ANTHROPIC_BASE_URL when it points at a non-Anthropic proxy.
 * Pure, network-free read of the environment; retained because callers use it
 * for display/bookkeeping. Returns undefined for the default Anthropic host.
 */
export function getApiBaseUrlHost(): string | undefined {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) return undefined
  try {
    const host = new URL(baseUrl).host
    if (host === 'api.anthropic.com') return undefined
    return host
  } catch {
    return undefined
  }
}

/** No analytics client is ever created. */
export async function initializeGrowthBook(): Promise<null> {
  return null
}

/** Feature value resolves to the caller's own default. */
export async function getFeatureValue_DEPRECATED<T>(
  _feature: string,
  defaultValue: T,
): Promise<T> {
  return defaultValue
}

/** Feature value resolves to the caller's own default. */
export function getFeatureValue_CACHED_MAY_BE_STALE<T>(
  _feature: string,
  defaultValue: T,
): T {
  return defaultValue
}

/** Feature value resolves to the caller's own default. */
export function getFeatureValue_CACHED_WITH_REFRESH<T>(
  _feature: string,
  defaultValue: T,
  _refreshIntervalMs: number,
): T {
  return defaultValue
}

/** Gate disabled — there is no remote gatekeeper in the stub. */
export function checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
  _gate: string,
): boolean {
  return false
}

/** Gate disabled. */
export async function checkSecurityRestrictionGate(
  _gate: string,
): Promise<boolean> {
  return false
}

/** Gate disabled. */
export async function checkGate_CACHED_OR_BLOCKING(
  _gate: string,
): Promise<boolean> {
  return false
}

/** No-op: no client to refresh. */
export function refreshGrowthBookAfterAuthChange(): void {}

/** No-op: nothing to reset. */
export function resetGrowthBook(): void {}

/** No-op: no remote features to refresh. */
export async function refreshGrowthBookFeatures(): Promise<void> {}

/** No-op: no periodic refresh timer is started. */
export function setupPeriodicGrowthBookRefresh(): void {}

/** No-op. */
export function stopPeriodicGrowthBookRefresh(): void {}

/** Dynamic config resolves to the caller's own default. */
export async function getDynamicConfig_BLOCKS_ON_INIT<T>(
  _configName: string,
  defaultValue: T,
): Promise<T> {
  return defaultValue
}

/** Dynamic config resolves to the caller's own default. */
export function getDynamicConfig_CACHED_MAY_BE_STALE<T>(
  _configName: string,
  defaultValue: T,
): T {
  return defaultValue
}
