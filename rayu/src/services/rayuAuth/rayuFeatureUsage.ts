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
import { IMAGE_GEN_FEATURE, IMAGE_GEN_LABEL } from '../../tools/ImageGenTool/constants.js'
import { VIDEO_GEN_FEATURE, VIDEO_GEN_LABEL } from '../../tools/VideoGenTool/constants.js'

export interface FeatureUsage {
  used: number
  /** Numeric monthly cap; null = unlimited. */
  limit: number | null
}

/** One feature's usage this month, labelled for display. */
export interface FeatureUsageRow extends FeatureUsage {
  key: string
  label: string
}

const REFRESH_COOLDOWN_MS = 60_000
/** The backend answers from one indexed query; anything slower is an outage. */
const REFRESH_TIMEOUT_MS = 10_000
let cache: Record<string, FeatureUsage> | null = null
let fetching = false
let lastAttempt = 0

/** Labels of the features the tools meter, in the order they are listed. */
const FEATURE_LABELS: ReadonlyMap<string, string> = new Map([
  [IMAGE_GEN_FEATURE, IMAGE_GEN_LABEL],
  [VIDEO_GEN_FEATURE, VIDEO_GEN_LABEL],
])

/**
 * Every feature in the cached usage, labelled: the tools' own labels first, then
 * any other key the backend reports, in sentence case ("web_search" → "Web search").
 * Null when usage is not known (see `getFeatureUsage`). Does not fetch.
 */
export function listFeatureUsage(): FeatureUsageRow[] | null {
  if (!cache) return null
  const known = [...FEATURE_LABELS.keys()].filter(key => cache?.[key])
  const others = Object.keys(cache).filter(key => !FEATURE_LABELS.has(key)).sort()
  return [...known, ...others].map(key => ({
    key,
    label: sentenceCase(FEATURE_LABELS.get(key) ?? key.replace(/[_-]+/g, ' ')),
    ...(cache as Record<string, FeatureUsage>)[key]!,
  }))
}

function sentenceCase(text: string): string {
  const trimmed = text.trim()
  return trimmed ? trimmed[0]!.toUpperCase() + trimmed.slice(1) : trimmed
}

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

/**
 * Fetch the per-feature usage map. Never throws; keeps the last good cache. Resolves
 * true only when this call replaced the cache with a fresh answer.
 */
export async function refreshFeatureUsage(): Promise<boolean> {
  if (!isUseRayuOAuthEnabled() || !hasRayuSession() || fetching) return false
  fetching = true
  lastAttempt = Date.now()
  try {
    const token = await getValidRayuAccessToken()
    if (!token) return false
    const res = await (globalThis.fetch as typeof fetch)(
      `${getRayuApiBaseUrl()}/usage/features`,
      {
        headers: { Authorization: `Bearer ${token}` },
        // The bearer token must not follow a redirect to another origin.
        redirect: 'error',
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      },
    )
    if (!res.ok) return false
    const next = parseFeatureUsage(await res.json())
    if (!next) return false
    cache = next
    return true
  } catch {
    // best-effort; keep the last good cache
    return false
  } finally {
    fetching = false
  }
}

/** The usage map in a `/usage/features` answer; unusable counts read as 0 used, no limit. */
function parseFeatureUsage(data: unknown): Record<string, FeatureUsage> | null {
  if (!data || typeof data !== 'object') return null
  const next: Record<string, FeatureUsage> = {}
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    const { used, limit } = v as Partial<Record<keyof FeatureUsage, unknown>>
    next[k] = {
      used: typeof used === 'number' && Number.isFinite(used) ? used : 0,
      limit: typeof limit === 'number' && Number.isFinite(limit) ? limit : null,
    }
  }
  return next
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
