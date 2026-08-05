// The post-AUTH-CHANGE refresh sequence.
//
// Whenever the session's identity changes — signing in or out of a Claude.ai
// subscription via /connect, and historically /login — a fixed set of caches and
// auth-dependent services has to be invalidated. Getting one wrong is a subtle
// bug (stale cost totals from the previous account, policy limits from the old
// org, MCP servers not re-fetched), so the sequence lives here ONCE and each step
// delegates to the module that owns it. Nothing is re-implemented.
//
// ORDER MATTERS:
//   • resetUserCache() runs BEFORE the GrowthBook refresh so the flag refresh
//     picks up the new credentials rather than the cached user.
//   • clearTrustedDeviceToken() runs BEFORE enrollTrustedDevice() so a stale
//     token from the previous account is never sent while enrollment is in
//     flight.
//   • authVersion is bumped LAST: hooks keyed on it (MCP servers, entitlements)
//     re-fetch, and by then every cache they read has already been cleared.
//
// Everything except the cache resets is fire-and-forget: a slow network must
// never block the /connect flow from returning to the prompt.
import { feature } from 'bun:bundle'
import type { AppState } from '../state/AppStateStore.js'
import { resetCostState } from '../bootstrap/state.js'
import { refreshGrowthBookAfterAuthChange } from '../services/analytics/growthbook.js'
import { refreshPolicyLimits } from '../services/policyLimits/index.js'
import { refreshRemoteManagedSettings } from '../services/remoteManagedSettings/index.js'
import {
  checkAndDisableAutoModeIfNeeded,
  checkAndDisableBypassPermissionsIfNeeded,
  resetAutoModeGateCheck,
  resetBypassPermissionsCheck,
} from './permissions/bypassPermissionsKillswitch.js'
import { resetUserCache } from './user.js'

/** The slice of the command context this sequence needs. */
export type PostAuthRefreshContext = {
  getAppState(): AppState
  setAppState(f: (prev: AppState) => AppState): void
}

/**
 * Run the post-auth-change refresh sequence.
 *
 * @param context command context (needs getAppState/setAppState)
 * @param opts.enrollDevice enroll this device for Remote Control. True after a
 *   SIGN-IN; false after a sign-out, where we only want the stale token cleared.
 */
export function runPostAuthChangeRefresh(
  context: PostAuthRefreshContext,
  opts: { enrollDevice?: boolean } = {},
): void {
  // Cost totals belong to the previous account.
  resetCostState()
  // Remotely-managed settings + policy limits are org-scoped (non-blocking).
  void refreshRemoteManagedSettings()
  void refreshPolicyLimits()
  // Clear user data cache BEFORE the GrowthBook refresh so it picks up fresh
  // credentials.
  resetUserCache()
  refreshGrowthBookAfterAuthChange()

  // Trusted-device token: always drop the old one; only re-enroll on sign-in
  // (the server gates enrollment on a fresh session, so it must happen now).
  void import('../bridge/trustedDevice.js').then(m => {
    m.clearTrustedDeviceToken()
    return opts.enrollDevice ? m.enrollTrustedDevice() : undefined
  })

  // Re-run the permission killswitch gates against the new org.
  resetBypassPermissionsCheck()
  const appState = context.getAppState()
  void checkAndDisableBypassPermissionsIfNeeded(
    appState.toolPermissionContext,
    context.setAppState,
  )
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    resetAutoModeGateCheck()
    void checkAndDisableAutoModeIfNeeded(
      appState.toolPermissionContext,
      context.setAppState,
      appState.fastMode,
    )
  }

  // Bump authVersion so auth-dependent hooks (MCP servers, etc.) re-fetch.
  context.setAppState(prev => ({ ...prev, authVersion: prev.authVersion + 1 }))
}
