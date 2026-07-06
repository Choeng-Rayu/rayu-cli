import {
  FEATURE_CATALOG,
  FEATURE_KEYS,
  allDisabled,
  allEnabled,
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
