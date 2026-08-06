// Data-driven feature entitlements.
//
// The CATALOG is the universe of gateable features the super-admin can toggle
// per plan from the dashboard. Per-plan entitlements are stored in
// `plans.limits.features` (JSON) so admins can change them at runtime in
// production without a schema migration. Each feature is a boolean `enabled`,
// with an optional numeric `limit` (e.g. max image generations) — null = no
// numeric cap.
//
// IMPORTANT: business logic (which features, defaults) is NOT hardcoded as the
// source of truth — the DB is. This file only defines the catalog (the set of
// features that exist) and first-time default helpers used by the seed.

export const FEATURE_KEYS = [
  'telegram',
  'collaborator_swarm',
  'subagent_model',
  'collaborator_model',
  'image_generation',
  'video_generation',
  'multi_api_keys',
] as const

export type FeatureKey = (typeof FEATURE_KEYS)[number]

export interface FeatureCatalogItem {
  key: FeatureKey
  label: string
  description: string
  /** Whether a numeric usage limit is meaningful for this feature. */
  supportsLimit: boolean
}

export const FEATURE_CATALOG: FeatureCatalogItem[] = [
  {
    key: 'telegram',
    label: 'Telegram bot',
    description: 'Use the /telegram-bot integration',
    supportsLimit: false,
  },
  {
    key: 'collaborator_swarm',
    label: 'Collaborator swarm',
    description: 'Multi-agent collaborator swarm',
    supportsLimit: true,
  },
  {
    key: 'subagent_model',
    label: 'Model per subagent',
    description: 'Change the model used per subagent',
    supportsLimit: false,
  },
  {
    key: 'collaborator_model',
    label: 'Collaborator model',
    description: 'Change the collaborator swarm model',
    supportsLimit: false,
  },
  {
    key: 'image_generation',
    label: 'Image generation',
    description: 'Generate images (GenerateImage tool)',
    supportsLimit: true,
  },
  {
    key: 'video_generation',
    label: 'Video generation',
    description: 'Generate videos',
    supportsLimit: true,
  },
  {
    key: 'multi_api_keys',
    label: 'Multiple API keys',
    description:
      'Store several API keys per provider (NVIDIA / OpenRouter) with automatic rate-limit failover between them',
    // Boolean capability, not a per-invocation usage-counted tool, so no numeric
    // monthly cap (the per-deployment key count is set via NUMBER_API_KEYS_STORE).
    supportsLimit: false,
  },
]

/**
 * Maps a limited feature to the CLI tool name(s) whose usage_events count toward
 * its numeric monthly limit. Tool names match the CLI tool identifiers (see each
 * tool's constants.ts). A feature with no mapping (e.g. collaborator_swarm) is
 * NOT numerically enforced — its usage is reported as 0, so a numeric limit on
 * it is effectively unlimited.
 */
export const FEATURE_TOOL_MAP: Partial<Record<FeatureKey, string[]>> = {
  image_generation: ['GenerateImage'],
  video_generation: ['GenerateVideo'],
}

/** The tool names whose usage counts toward a feature's limit ([] if none). */
export function toolsForFeature(key: FeatureKey): string[] {
  return FEATURE_TOOL_MAP[key] ?? []
}

export interface FeatureEntitlement {
  enabled: boolean
  /** Optional numeric cap; null = unlimited when enabled. */
  limit?: number | null
}

export type FeatureEntitlements = Partial<Record<FeatureKey, FeatureEntitlement>>

/** Every feature disabled — safe default when a plan has no config. */
export function allDisabled(): Record<FeatureKey, FeatureEntitlement> {
  return Object.fromEntries(
    FEATURE_KEYS.map((k) => [k, { enabled: false, limit: null }]),
  ) as Record<FeatureKey, FeatureEntitlement>
}

/** Every feature enabled, unlimited. */
export function allEnabled(): Record<FeatureKey, FeatureEntitlement> {
  return Object.fromEntries(
    FEATURE_KEYS.map((k) => [k, { enabled: true, limit: null }]),
  ) as Record<FeatureKey, FeatureEntitlement>
}

/**
 * Normalize stored/partial entitlements into a complete map across all catalog
 * keys, dropping unknown keys and coercing shapes. Missing keys = disabled.
 */
export function resolveEntitlements(
  stored: unknown,
): Record<FeatureKey, FeatureEntitlement> {
  const base = allDisabled()
  if (stored && typeof stored === 'object') {
    for (const key of FEATURE_KEYS) {
      const v = (stored as Record<string, unknown>)[key]
      if (v && typeof v === 'object') {
        const enabled = Boolean((v as FeatureEntitlement).enabled)
        const rawLimit = (v as FeatureEntitlement).limit
        const limit =
          typeof rawLimit === 'number' && Number.isFinite(rawLimit)
            ? rawLimit
            : null
        base[key] = { enabled, limit }
      }
    }
  }
  return base
}

/**
 * Non-destructively fill in catalog feature keys that are MISSING from a plan's
 * stored entitlements, using per-plan defaults (falls back to disabled when the
 * default omits a key). Existing keys are NEVER changed, so admin toggles are
 * preserved — this only rolls a newly-added catalog feature onto pre-existing
 * plans with its intended default.
 *
 * Used by the seed on boot: when a feature (e.g. `multi_api_keys`) is added to
 * the catalog AFTER plans were first created, their stored `limits.features`
 * lacks the key and would otherwise resolve to disabled forever. This backfills
 * it (paid plans → enabled, free → disabled) from the plan's seed defaults.
 *
 * Returns the merged feature map and the list of keys that were added (empty =
 * nothing to persist).
 */
export function backfillMissingFeatures(
  stored: unknown,
  defaults: FeatureEntitlements,
): { features: Record<string, FeatureEntitlement>; added: FeatureKey[] } {
  const current: Record<string, FeatureEntitlement> =
    stored && typeof stored === 'object'
      ? { ...(stored as Record<string, FeatureEntitlement>) }
      : {}
  const added: FeatureKey[] = []
  for (const key of FEATURE_KEYS) {
    if (!(key in current)) {
      const d = defaults[key]
      current[key] = d
        ? { enabled: Boolean(d.enabled), limit: d.limit ?? null }
        : { enabled: false, limit: null }
      added.push(key)
    }
  }
  return { features: current, added }
}

/**
 * Validate an incoming partial entitlements patch from the admin dashboard.
 * Returns a sanitized map containing only known keys. Throws on malformed
 * input so the controller can return 400.
 */
export function sanitizeEntitlementsPatch(input: unknown): FeatureEntitlements {
  if (!input || typeof input !== 'object') {
    throw new Error('features must be an object')
  }
  const out: FeatureEntitlements = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(FEATURE_KEYS as readonly string[]).includes(key)) {
      throw new Error(`unknown feature: ${key}`)
    }
    if (!value || typeof value !== 'object') {
      throw new Error(`feature ${key} must be an object`)
    }
    const enabled = Boolean((value as FeatureEntitlement).enabled)
    const rawLimit = (value as FeatureEntitlement).limit
    let limit: number | null = null
    if (rawLimit !== null && rawLimit !== undefined) {
      if (
        typeof rawLimit !== 'number' ||
        !Number.isFinite(rawLimit) ||
        rawLimit < 0
      ) {
        throw new Error(`feature ${key} limit must be a non-negative number`)
      }
      limit = rawLimit
    }
    out[key as FeatureKey] = { enabled, limit }
  }
  return out
}
