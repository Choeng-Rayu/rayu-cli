// Read-only, cached view of the signed-in user's per-feature usage THIS MONTH
// (GET /usage/features), used to enforce the admin-configured numeric feature
// limits (e.g. image generation = 10/month) as a SOFT client-side cap.
//
// Mirrors rayuPlansCatalog.ts: a sync getter + a rate-limited background
// refresh that fails open (no data -> not limited). Image/video generation use
// the user's OWN provider keys and never traverse Rayu's gateway, so there is
// no Rayu-side cost — this is a UX allowance, not a hard security boundary
// (same trust model as rayuFeatureAllowed). The limit window is the UTC
// calendar month, computed server-side.
import {
  getRayuApiBaseUrl,
  getValidRayuAccessToken,
  hasRayuSession,
  isUseRayuOAuthEnabled,
} from './rayuSession.js'

export interface FeatureUsage {
  used: number
  /** Numeric monthly cap; null = unlimited. */
  limit: number | null
}

const REFRESH_COOLDOWN_MS = 60_000
let cache: Record<string, FeatureUsage> | null = null
let fetching = false
let lastAttempt = 0

/**
 * The cached `{ used, limit }` for a feature, or null when unknown (offline,
 * pre-fetch, signed out, or OAuth off). Sync; kicks a rate-limited background
 * refresh so the next read is fresh.
 */
export function getFeatureUsage(featureKey: string): FeatureUsage | null {
  maybeRefreshFeatureUsage()
  if (!cache) return null
  return cache[featureKey] ?? null
}

function maybeRefreshFeatureUsage(): void {
  if (
    isUseRayuOAuthEnabled() &&
    hasRayuSession() &&
    !fetching &&
    Date.now() - lastAttempt > REFRESH_COOLDOWN_MS
  ) {
    void refreshFeatureUsage()
  }
}

/** Fetch the per-feature usage map. Never throws; keeps the last good cache. */
export async function refreshFeatureUsage(): Promise<void> {
  if (!isUseRayuOAuthEnabled() || !hasRayuSession() || fetching) return
  fetching = true
  lastAttempt = Date.now()
  try {
    const token = await getValidRayuAccessToken()
    if (!token) return
    const res = await (globalThis.fetch as typeof fetch)(
      `${getRayuApiBaseUrl()}/usage/features`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    if (!res.ok) return
    const data: unknown = await res.json()
    if (data && typeof data === 'object') {
      const next: Record<string, FeatureUsage> = {}
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        if (v && typeof v === 'object') {
          const rawUsed = (v as FeatureUsage).used
          const rawLimit = (v as FeatureUsage).limit
          const used =
            typeof rawUsed === 'number' && Number.isFinite(rawUsed) ? rawUsed : 0
          const limit =
            typeof rawLimit === 'number' && Number.isFinite(rawLimit)
              ? rawLimit
              : null
          next[k] = { used, limit }
        }
      }
      cache = next
    }
  } catch {
    // best-effort; keep the last good cache
  } finally {
    fetching = false
  }
}

/**
 * Optimistically bump a feature's local used count after a successful action,
 * so the in-session cap reflects it immediately. The durable backend
 * usage_events row is written separately by the per-tool usage ping. No-op when
 * the feature isn't cached yet.
 */
export function bumpFeatureUsage(featureKey: string): void {
  if (!cache) return
  const cur = cache[featureKey]
  if (cur) cache[featureKey] = { ...cur, used: cur.used + 1 }
}

/** Forget cached usage (call on logout). */
export function clearFeatureUsage(): void {
  cache = null
  lastAttempt = 0
}

// --- Test hooks -------------------------------------------------------------

export function _setFeatureUsageForTesting(
  map: Record<string, FeatureUsage> | null,
): void {
  cache = map
  // Set lastAttempt so getFeatureUsage() won't kick a real network refresh.
  lastAttempt = Date.now()
}

export function _resetFeatureUsageForTesting(): void {
  cache = null
  fetching = false
  lastAttempt = 0
}
