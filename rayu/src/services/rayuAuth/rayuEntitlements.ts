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
  /** Hosted models the user's plan can use (drives the rayu-hosted provider). */
  allowedModels?: AllowedModel[]
  creditAllowance?: {
    creditsPerWeek: number | null
    creditsPer5h: number | null
    topUpEnabled: boolean
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
 * Fails OPEN: returns true when Rayu OAuth is disabled, or when entitlements
 * are not (yet) available. Only returns false when the admin-configured
 * entitlements explicitly disable the feature.
 */
export function rayuFeatureAllowed(featureKey: string): boolean {
  if (!isUseRayuOAuthEnabled()) return true
  const ent = getCachedEntitlements()
  if (!ent || !ent.features) return true
  const f = ent.features[featureKey]
  if (!f) return true
  return f.enabled !== false
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
