// Keeps the local "rayu-hosted" provider config in sync with the signed-in
// user's entitlements. When a paid plan grants hosted models, the provider is
// registered (and, on login, activated) so the user can pick a hosted model
// with NO /connect and NO API key — auth is the Rayu JWT, and the gateway holds
// the upstream provider key. When the entitlement goes away (free/expired), the
// provider is removed so the model picker never shows stale hosted models.
import {
  loadRayuConfig,
  saveRayuConfig,
  type RayuProvider,
} from '../../utils/rayuConfig.js'
import { RAYU_HOSTED_PROVIDER_ID } from '../../utils/rayuProviders.js'
import { rayuHostedBaseURL } from '../api/rayuHosted/rayuHostedAuth.js'
import type { RayuEntitlements } from './rayuEntitlements.js'

/**
 * Reconcile the rayu-hosted provider with the given entitlements.
 * - With hosted models: upsert the provider (baseURL + model list). When
 *   opts.activate is set (i.e. just logged in), make it the active provider.
 * - Without hosted models: remove the provider and de-activate it if it was
 *   active. Best-effort — never throws (must not break login/refresh).
 */
export function syncRayuHostedProvider(
  ent: RayuEntitlements | null,
  opts?: { activate?: boolean },
): void {
  try {
    const cfg = loadRayuConfig()
    const allowed = ent?.allowedModels ?? []
    const models = allowed.map((m) => m.code)
    const idx = cfg.providers.findIndex((p) => p.id === RAYU_HOSTED_PROVIDER_ID)

    if (models.length > 0) {
      const existing = idx >= 0 ? cfg.providers[idx] : undefined
      const firstCode = allowed[0]?.code
      const provider: RayuProvider = {
        ...existing,
        id: RAYU_HOSTED_PROVIDER_ID,
        kind: 'rayu-hosted',
        baseURL: rayuHostedBaseURL(),
        models,
        fetchedModels: models,
        defaultModel: existing?.defaultModel ?? firstCode,
        smallFastModel: existing?.smallFastModel ?? firstCode,
      }
      if (idx >= 0) cfg.providers[idx] = provider
      else cfg.providers.push(provider)
      if (opts?.activate) cfg.activeProvider = RAYU_HOSTED_PROVIDER_ID
      saveRayuConfig(cfg)
      return
    }

    // No hosted entitlement — drop a previously-registered hosted provider.
    if (idx >= 0) {
      cfg.providers.splice(idx, 1)
      if (cfg.activeProvider === RAYU_HOSTED_PROVIDER_ID) {
        cfg.activeProvider = cfg.providers[0]?.id
      }
      saveRayuConfig(cfg)
    }
  } catch {
    // best-effort: provider sync must never break the login/entitlements flow
  }
}
