import {
  FEATURE_CATALOG,
  FEATURE_KEYS,
  allDisabled,
  allEnabled,
  backfillMissingFeatures,
  resolveEntitlements,
  sanitizeEntitlementsPatch,
} from './features'

// The multi-API-key feature (multiple keys per NVIDIA/OpenRouter provider with
// rate-limit failover) must be an ADMIN-CONFIGURABLE per-plan entitlement — not
// hardcoded. Adding it to FEATURE_KEYS/FEATURE_CATALOG is what makes it appear
// in the admin dashboard's Plans & Features page, pass PATCH validation, and
// flow through /me/entitlements to the CLI gate. These tests lock that in.
describe('feature catalog: multi_api_keys', () => {
  it('is registered in FEATURE_KEYS and FEATURE_CATALOG', () => {
    expect(FEATURE_KEYS).toContain('multi_api_keys')
    const item = FEATURE_CATALOG.find((f) => f.key === 'multi_api_keys')
    expect(item).toBeDefined()
    expect(item?.label).toBeTruthy()
    expect(item?.description).toBeTruthy()
    // Boolean capability — no numeric monthly-usage cap.
    expect(item?.supportsLimit).toBe(false)
  })

  it('catalog and keys stay in sync (dashboard renders one toggle per key)', () => {
    expect(FEATURE_CATALOG.map((f) => f.key).sort()).toEqual(
      [...FEATURE_KEYS].sort(),
    )
  })

  it('seed defaults cover it (fresh installs: Free off / paid on)', () => {
    expect(allDisabled().multi_api_keys).toEqual({ enabled: false, limit: null })
    expect(allEnabled().multi_api_keys).toEqual({ enabled: true, limit: null })
  })

  it('admin PATCH sanitizer accepts enabling it per plan', () => {
    const patch = sanitizeEntitlementsPatch({ multi_api_keys: { enabled: true } })
    expect(patch.multi_api_keys).toEqual({ enabled: true, limit: null })
  })

  it('resolveEntitlements exposes it to /me/entitlements', () => {
    // Not yet stored on an existing plan → disabled (Free users stay locked
    // until the admin enables it), proving it is not silently on.
    expect(resolveEntitlements({}).multi_api_keys).toEqual({
      enabled: false,
      limit: null,
    })
    // Admin-enabled on a plan → enabled, which the CLI gate reads to unlock.
    expect(
      resolveEntitlements({ multi_api_keys: { enabled: true } }).multi_api_keys,
    ).toEqual({ enabled: true, limit: null })
  })

  it('still rejects unknown feature keys (catalog is the source of truth)', () => {
    expect(() =>
      sanitizeEntitlementsPatch({ not_a_feature: { enabled: true } }),
    ).toThrow()
  })
})

// The seed backfill is what actually lets a Pro/Basic account receive a
// newly-added catalog feature: existing plan rows predate the feature, so their
// stored limits.features lacks it and it would resolve to disabled forever.
describe('backfillMissingFeatures (roll new catalog features onto existing plans)', () => {
  it('adds a missing feature from the plan seed default (paid plan → enabled)', () => {
    // A paid plan created before multi_api_keys existed: everything else on,
    // but the key is simply absent.
    const stored = {
      telegram: { enabled: true, limit: null },
      collaborator_swarm: { enabled: true, limit: null },
      subagent_model: { enabled: true, limit: null },
      collaborator_model: { enabled: true, limit: null },
      image_generation: { enabled: true, limit: null },
      video_generation: { enabled: true, limit: null },
    }
    const { features, added } = backfillMissingFeatures(stored, allEnabled())
    expect(added).toEqual(['multi_api_keys'])
    expect(features.multi_api_keys).toEqual({ enabled: true, limit: null })
  })

  it('fills the free plan default as disabled', () => {
    const { features, added } = backfillMissingFeatures(
      { telegram: { enabled: false, limit: null } },
      allDisabled(),
    )
    expect(added).toContain('multi_api_keys')
    expect(features.multi_api_keys).toEqual({ enabled: false, limit: null })
  })

  it('is non-destructive: never overwrites an existing admin toggle', () => {
    // Admin already disabled multi_api_keys on this (otherwise paid) plan.
    const stored = { ...allEnabled(), multi_api_keys: { enabled: false, limit: null } }
    const { features, added } = backfillMissingFeatures(stored, allEnabled())
    expect(added).toEqual([]) // nothing missing → no writes
    expect(features.multi_api_keys).toEqual({ enabled: false, limit: null })
  })

  it('falls back to disabled when the seed default omits the key', () => {
    const { features } = backfillMissingFeatures({}, {})
    expect(features.multi_api_keys).toEqual({ enabled: false, limit: null })
    // every catalog key is present after backfill
    expect(Object.keys(features).sort()).toEqual([...FEATURE_KEYS].sort())
  })

  it('handles null/absent stored features (older plan with no features JSON)', () => {
    const { features, added } = backfillMissingFeatures(null, allEnabled())
    expect(added).toEqual([...FEATURE_KEYS]) // all keys added
    expect(features.multi_api_keys).toEqual({ enabled: true, limit: null })
  })
})
