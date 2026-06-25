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
 * - With a hosted CATALOG (hostedModels, else allowedModels): upsert the
 *   provider so it is ALWAYS visible (Free + Paid). The default model prefers an
 *   ENTITLED model so paid users land on something usable. On login
 *   (opts.activate) it is made the active provider ONLY when the user is
 *   entitled to at least one hosted model — Free users keep their own active
 *   provider but still SEE the hosted provider pinned at the top.
 * - With no catalog at all (signed out / OAuth off / no hosted models): remove
 *   the provider. Best-effort — never throws (must not break login/refresh).
 */
export function syncRayuHostedProvider(
  ent: RayuEntitlements | null,
  opts?: { activate?: boolean },
): void {
  try {
    const cfg = loadRayuConfig()
    // Visibility uses the full catalog; usability uses the entitled subset.
    const catalog = ent?.hostedModels ?? ent?.allowedModels ?? []
    const entitled = ent?.allowedModels ?? []
    const models = catalog.map((m) => m.code)
    const idx = cfg.providers.findIndex((p) => p.id === RAYU_HOSTED_PROVIDER_ID)

    if (models.length > 0) {
      const existing = idx >= 0 ? cfg.providers[idx] : undefined
      // Prefer an entitled model as the default so paid users land on a usable
      // one; fall back to the first catalog model (Free — gated on use).
      const preferredCode = entitled[0]?.code ?? catalog[0]?.code
      const provider: RayuProvider = {
        ...existing,
        id: RAYU_HOSTED_PROVIDER_ID,
        kind: 'rayu-hosted',
        baseURL: rayuHostedBaseURL(),
        models,
        fetchedModels: models,
        defaultModel: existing?.defaultModel ?? preferredCode,
        smallFastModel: existing?.smallFastModel ?? preferredCode,
      }
      if (idx >= 0) cfg.providers[idx] = provider
      else cfg.providers.push(provider)
      // Auto-activate on login ONLY when entitled — never hijack a Free user's
      // own provider (they can still pick a hosted model and get the upgrade ask).
      if (opts?.activate && entitled.length > 0) {
        cfg.activeProvider = RAYU_HOSTED_PROVIDER_ID
      }
      saveRayuConfig(cfg)
      return
    }

    // No hosted catalog at all — drop a previously-registered hosted provider.
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
