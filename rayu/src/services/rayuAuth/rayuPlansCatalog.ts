// Read-only view of the ADMIN-CONFIGURED plan catalog (public GET /plans).
//
// The CLI uses this ONLY to name the upgrade target in paid-feature prompts.
// The plan name and price come from whatever the super-admin configured in the
// dashboard/DB — they are NEVER hardcoded in the CLI. Fetched lazily, cached in
// memory with a rate-limited background refresh, and fails open (no catalog ->
// the caller uses generic copy like "a paid plan").
//
// SCOPE: this is display-only. It does not gate anything; gating is driven by
// rayuFeatureAllowed() (per-user entitlements). Both ultimately reflect the
// admin's configuration, not code constants.
import { getRayuApiBaseUrl, isUseRayuOAuthEnabled } from './rayuSession.js'

export interface RayuPlanSummary {
  code: string
  name: string
  priceCents: number
  availability: string
}

const REFRESH_COOLDOWN_MS = 60_000
let cache: RayuPlanSummary[] | null = null
let fetching = false
let lastAttempt = 0

/**
 * The natural upgrade target for a gated Free user: the cheapest ACTIVE plan
 * with a real price (priceCents > 0), as configured by the admin. Returns null
 * when the catalog isn't known yet — callers fall back to generic copy.
 *
 * Sync + kicks a rate-limited background refresh, mirroring
 * getCachedEntitlements()'s pattern.
 */
export function getEntryPaidPlan(): RayuPlanSummary | null {
  maybeRefreshPlansCatalog()
  if (!cache) return null
  let best: RayuPlanSummary | null = null
  for (const p of cache) {
    if (p.availability === 'active' && p.priceCents > 0) {
      if (!best || p.priceCents < best.priceCents) best = p
    }
  }
  return best
}

function maybeRefreshPlansCatalog(): void {
  if (
    isUseRayuOAuthEnabled() &&
    !fetching &&
    Date.now() - lastAttempt > REFRESH_COOLDOWN_MS
  ) {
    void refreshPlansCatalog()
  }
}

/** Fetch the public plan catalog. Never throws; keeps the last good cache. */
export async function refreshPlansCatalog(): Promise<void> {
  if (!isUseRayuOAuthEnabled() || fetching) return
  fetching = true
  lastAttempt = Date.now()
  try {
    const res = await (globalThis.fetch as typeof fetch)(
      `${getRayuApiBaseUrl()}/plans`,
    )
    if (!res.ok) return
    const data: unknown = await res.json()
    if (Array.isArray(data)) {
      cache = data
        .filter(
          (p): p is RayuPlanSummary =>
            !!p &&
            typeof p === 'object' &&
            typeof (p as RayuPlanSummary).name === 'string' &&
            typeof (p as RayuPlanSummary).priceCents === 'number',
        )
        .map((p) => ({
          code: String((p as RayuPlanSummary).code),
          name: (p as RayuPlanSummary).name,
          priceCents: (p as RayuPlanSummary).priceCents,
          availability: String((p as RayuPlanSummary).availability),
        }))
    }
  } catch {
    // best-effort; keep the last good cache
  } finally {
    fetching = false
  }
}

// --- Test hooks -------------------------------------------------------------

export function _setPlansCatalogForTesting(
  plans: RayuPlanSummary[] | null,
): void {
  cache = plans
  // Set lastAttempt so getEntryPaidPlan() won't kick a real network refresh.
  lastAttempt = Date.now()
}

export function _resetPlansCatalogForTesting(): void {
  cache = null
  fetching = false
  lastAttempt = 0
}
