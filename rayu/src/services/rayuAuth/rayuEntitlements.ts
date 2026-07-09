// Rayu plan entitlements for the CLI.
//
// When USE_RAYU_OAUTH is enabled and the user is signed in, the CLI fetches the
// signed-in user's entitlements from the backend (GET /me/entitlements) — the
// plan + per-feature toggles/limits + usage caps that the SUPER-ADMIN configures
// in the dashboard. Feature gating (telegram, swarm, image/video gen, etc.) is
// then driven entirely by that admin configuration; nothing is hardcoded.
//
// SCOPE / THREAT MODEL (read this): this is CLIENT-SIDE gating. It hides and
// disables gated features in the UX, but it is NOT a hard security boundary —
// a user who controls their own machine can bypass it (toggle USE_RAYU_OAUTH,
// edit the cache file, point RAYU_API_URL at a fake server, or patch the
// binary). True, tamper-proof enforcement must be SERVER-SIDE (the backend
// refusing the action), which only applies to capabilities that flow through
// Rayu's backend (e.g. the future Rayu-hosted model gateway / usage authorize).
// We still harden the client where cheap: bind the cache to the signed-in user
// and avoid trusting a foreign/stale cache.
//
// Design notes:
// - Cached in memory + persisted to ~/.rayu/rayu-entitlements.json so gating is
//   correct immediately at startup (sync reads), with a background refresh that
//   is rate-limited (cooldown) so a down backend can't cause a request storm.
// - `rayuFeatureAllowed()` is SYNCHRONOUS and FAILS OPEN (a backend hiccup
//   never blocks the CLI).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getRayuConfigHomeDir } from '../../utils/envUtils.js'
import { syncRayuHostedProvider } from './rayuHostedProvider.js'
import {
  getRayuApiBaseUrl,
  getRayuWebBaseUrl,
  getValidRayuAccessToken,
  hasRayuSession,
  isUseRayuOAuthEnabled,
  readRayuSession,
} from './rayuSession.js'

export interface FeatureEntitlement {
  enabled: boolean
  limit?: number | null
}

export interface AllowedModel {
  code: string
  label: string
  provider: string
  creditMultiplier: number
}

export interface RayuEntitlements {
  plan: {
    code: string
    name: string
    priceCents: number
    availability: string
    currentPeriodEnd?: string | null
  }
  maxDailyTurns: number | null
  features: Record<string, FeatureEntitlement>
  /** Hosted models the user's plan can USE (drives entitlement/gating). */
  allowedModels?: AllowedModel[]
  /**
   * Full enabled hosted catalog — shown to EVERY signed-in user so the
   * rayu-hosted provider is always visible. A model is usable iff it also
   * appears in allowedModels. Falls back to allowedModels when absent (older
   * backend).
   */
  hostedModels?: AllowedModel[]
  /**
   * Paid-plan credit allowance from the backend (`/me/entitlements`). This is a
   * per-billing-period balance consumed by the gateway — 1 credit =
   * (1e6 / baselineCreditsPer1M) tokens. The legacy windowed fields
   * (creditsPerWeek/creditsPer5h) are gone; the gateway is the billing source of
   * truth and reports live usage via GET /v1/credits.
   */
  creditAllowance?: {
    creditsPerPeriod: number | null
    topUpEnabled: boolean
  }
  /** Credit model config (mirrors the admin Credit Settings). */
  creditConfig?: {
    baselineCreditsPer1M: number
    tokensPerCredit: number
  }
  topupBalance?: number
  /** Bound to the session user this cache belongs to (anti cross-user reuse). */
  userId?: number | null
}

const FILE = 'rayu-entitlements.json'
const REFRESH_COOLDOWN_MS = 30_000

let cache: RayuEntitlements | null = null
let loadedFromDisk = false
let fetching = false
let lastAttempt = 0

function entitlementsPath(): string {
  return join(getRayuConfigHomeDir(), FILE)
}

function currentUserId(): number | null {
  return readRayuSession()?.user?.id ?? null
}

function loadFromDiskOnce(): void {
  if (loadedFromDisk) return
  loadedFromDisk = true
  try {
    const p = entitlementsPath()
    if (existsSync(p)) {
      cache = JSON.parse(readFileSync(p, 'utf8')) as RayuEntitlements
    }
  } catch {
    cache = null
  }
}

function persist(ent: RayuEntitlements | null): void {
  try {
    const dir = getRayuConfigHomeDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const p = entitlementsPath()
    if (ent) writeFileSync(p, JSON.stringify(ent, null, 2), { mode: 0o600 })
    else rmSync(p, { force: true })
  } catch {
    // best-effort
  }
}

/**
 * Return the cached entitlements (sync). Loads the persisted copy on first
 * call, discards a cache that belongs to a different user, and kicks a
 * rate-limited background refresh when the cache is empty.
 */
export function getCachedEntitlements(): RayuEntitlements | null {
  loadFromDiskOnce()

  // Never trust a cache that was minted for a different signed-in user.
  if (cache && cache.userId != null) {
    const uid = currentUserId()
    if (uid != null && uid !== cache.userId) {
      cache = null
    }
  }

  // Kick a rate-limited background refresh whenever the cooldown has elapsed —
  // NOT only when the cache is empty. Otherwise a cache minted while the user
  // was on Free (and persisted to disk) would never refresh after they upgrade,
  // leaving paid features (e.g. telegram) hidden until the cache is cleared.
  // The cooldown + `fetching` guard keep this from storming the backend.
  if (
    isUseRayuOAuthEnabled() &&
    hasRayuSession() &&
    !fetching &&
    Date.now() - lastAttempt > REFRESH_COOLDOWN_MS
  ) {
    void refreshRayuEntitlements()
  }
  return cache
}

/**
 * Fetch entitlements from the backend and update the cache. Never throws.
 * Rate-limited via a cooldown so repeated sync calls (menu re-renders) cannot
 * storm the backend when it is unreachable.
 */
export async function refreshRayuEntitlements(): Promise<RayuEntitlements | null> {
  if (!isUseRayuOAuthEnabled() || !hasRayuSession()) return null
  if (fetching) return cache
  fetching = true
  lastAttempt = Date.now()
  try {
    const token = await getValidRayuAccessToken()
    if (!token) return cache
    const res = await (globalThis.fetch as typeof fetch)(
      `${getRayuApiBaseUrl()}/me/entitlements`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    if (!res.ok) return cache
    const data = (await res.json()) as RayuEntitlements
    // Bind to the current session user so the file can't be reused by another.
    data.userId = currentUserId()
    cache = data
    loadedFromDisk = true
    persist(data)
    // Keep the rayu-hosted provider config in sync with entitlements. No
    // activation here (background refresh must not hijack the user's choice).
    syncRayuHostedProvider(data)
    return data
  } catch {
    return cache
  } finally {
    fetching = false
  }
}

/** Forget cached entitlements (call on logout). */
export function clearRayuEntitlements(): void {
  cache = null
  loadedFromDisk = true
  lastAttempt = 0
  persist(null)
  // Drop the rayu-hosted provider so a logged-out user has no hosted models.
  syncRayuHostedProvider(null)
}

/**
 * Whether a gated feature is allowed for the current user.
 *
 * Resolution:
 * - Rayu OAuth OFF              -> allowed (feature gating not in effect).
 * - Entitlements present        -> the admin-configured `enabled` flag decides;
 *                                  an unknown/missing feature key stays allowed.
 * - No entitlements + signed in -> DENY gated features. We have a session, so we
 *                                  should know the plan; failing open here is
 *                                  what let free users use paid features before
 *                                  the first fetch. getCachedEntitlements() also
 *                                  schedules a rate-limited background refresh.
 * - No entitlements + signed out -> allowed (the login gate governs access;
 *                                  don't double-block pre-login).
 *
 * Still resilient: a transient refresh failure leaves the LAST good cache in
 * place, so we only deny when there is genuinely no cache for a signed-in user.
 */
export function rayuFeatureAllowed(featureKey: string): boolean {
  if (!isUseRayuOAuthEnabled()) return true
  const ent = getCachedEntitlements()
  if (ent && ent.features) {
    const f = ent.features[featureKey]
    if (!f) return true
    return f.enabled !== false
  }
  // No entitlements cached. If the user is signed in we should know their plan,
  // so DENY gated features to close the cold-start window that previously let
  // free users through. If not signed in, the login gate governs access.
  return !hasRayuSession()
}

/**
 * Whether the signed-in user may USE a given Rayu-hosted model. Visibility (the
 * provider/model list) is decoupled from usability: every signed-in user sees
 * the hosted catalog, but only models in `allowedModels` are usable.
 *
 * Fails OPEN: when OAuth is off or entitlements aren't loaded yet, returns true
 * so the gateway stays the authoritative gate and a backend hiccup never blocks
 * a paid user.
 */
export function isHostedModelEntitled(modelCode: string): boolean {
  if (!isUseRayuOAuthEnabled()) return true
  const ent = getCachedEntitlements()
  if (!ent) return true // unknown → let the gateway decide
  const allowed = ent.allowedModels ?? []
  return allowed.some((m) => m.code === modelCode)
}

/**
 * Whether the signed-in user's plan can use ANY Rayu-hosted model — i.e. their
 * `allowedModels` is non-empty. Used by the client-side block-on-use gate to
 * decide whether to short-circuit with the upgrade message.
 *
 * IMPORTANT: this is deliberately COARSE (plan has hosted access at all), NOT a
 * per-model exact-code match. A paid user's request can legitimately carry a
 * model string that isn't an exact allowedModels code — subagent/side-query
 * models, provider-prefixed or variant ids, etc. Blocking those client-side with
 * "upgrade your plan" is both wrong (they ARE a paid user) and misleading. The
 * gateway is the authoritative per-model + billing gate and returns accurate
 * errors ("model not available on your plan", credit limits, upstream 403/404),
 * so the client only needs to catch the clear case: a user with NO hosted access
 * (e.g. Free) trying to use hosted models. Fails OPEN (unknown → allow).
 */
export function hasHostedModelAccess(): boolean {
  if (!isUseRayuOAuthEnabled()) return true
  const ent = getCachedEntitlements()
  if (!ent) return true // unknown → let the gateway decide
  return (ent.allowedModels ?? []).length > 0
}

/**
 * Friendly message shown to a Free user who tries to USE a hosted model,
 * including the upgrade link. Self-contained (no plan-catalog import).
 */
export function hostedModelUpgradeMessage(): string {
  const url = `${getRayuWebBaseUrl()}/plans`
  return `🔒 Rayu-hosted models are a paid feature. Please upgrade your plan to use them: ${url}`
}

// --- Test hooks -------------------------------------------------------------

export function _setRayuEntitlementsForTesting(
  ent: RayuEntitlements | null,
): void {
  cache = ent
  loadedFromDisk = true
}

export function _resetRayuEntitlementsForTesting(): void {
  cache = null
  loadedFromDisk = false
  fetching = false
  lastAttempt = 0
}
