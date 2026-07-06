// Entitlement gate for multi-API-key storage + rate-limit key rotation on the
// NVIDIA / OpenRouter providers.
//
// PRODUCT RULE: this is a PAID feature — available on the Basic plan and up,
// NOT to all Free users. Like every other gated capability in the CLI
// (image/video generation, telegram, swarm, …) the actual per-plan grant is
// ADMIN-CONFIGURED in the dashboard as the `multi_api_keys` feature entitlement;
// nothing about which plan gets it is hardcoded here.
//
// This differs from the generic rayuFeatureAllowed() in ONE deliberate way: the
// generic helper fails OPEN for an UNKNOWN feature key (so a not-yet-configured
// feature isn't accidentally hidden). For a paid-by-default feature that would
// be backwards — it would hand multi-key to Free users until the admin flipped
// it off. So here a signed-in user whose plan does NOT explicitly grant
// `multi_api_keys` is DENIED. The BYOK / open-source path (Rayu OAuth OFF) and
// the pre-login state are unaffected (allowed), matching the rest of the CLI.
//
// SCOPE / THREAT MODEL: this is CLIENT-SIDE soft gating (same as the rest of the
// entitlement system) — it shapes the UX, not a hard security boundary. It fails
// safe for the product intent (deny on cold-start for signed-in users) while
// never blocking the open-source BYOK path.

import { getCachedEntitlements } from './rayuEntitlements.js'
import { hasRayuSession, isUseRayuOAuthEnabled } from './rayuSession.js'

/** Admin-configured entitlement key for the multi-API-key feature. */
export const MULTI_API_KEY_FEATURE = 'multi_api_keys'

/**
 * Whether the signed-in user may STORE multiple API keys and use rate-limit key
 * rotation (Basic plan and up).
 *
 * Resolution:
 * - Rayu OAuth OFF (BYOK / open-source)  -> allowed (gating not in effect).
 * - Signed out (Rayu OAuth on)           -> allowed (login gate governs access).
 * - Signed in + entitlement present      -> the admin `enabled` flag decides.
 * - Signed in + entitlement absent/cold  -> DENIED (paid-by-default; Basic-only).
 *
 * Synchronous + fail-safe-for-intent: getCachedEntitlements() schedules a
 * rate-limited background refresh, so a freshly-upgraded Basic user unlocks
 * within the refresh cooldown without any extra plumbing.
 */
export function isMultiApiKeyAllowed(): boolean {
  if (!isUseRayuOAuthEnabled()) return true
  if (!hasRayuSession()) return true
  const ent = getCachedEntitlements()
  const f = ent?.features?.[MULTI_API_KEY_FEATURE]
  if (!f) return false
  return f.enabled !== false
}
