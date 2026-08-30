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
import {
  catalogSignature,
  hostedContextWindows,
  hostedModelLabels,
} from './rayuModelCatalog.js'
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
 *
 * The catalog is SERVER-DRIVEN: whatever the admin has in the dashboard is what
 * lands here on the next entitlements refresh, so a newly added model shows up in
 * /model automatically and a removed one disappears. The model ID, its display
 * NAME, and its CONTEXT WINDOW all come from that same payload — none of them is
 * hardcoded in the CLI, so renaming a model or raising its window in the
 * dashboard needs no CLI release.
 *
 * Scope: this function only ever touches the provider whose id is
 * RAYU_HOSTED_PROVIDER_ID. Every other provider entry in the user's config is
 * left exactly as it is.
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
      // Keep the user's chosen default/small model ONLY while it still exists in
      // the catalog. An admin can rename, disable, or delete a model at any time;
      // holding on to a code that is gone would send every request to a model the
      // gateway now rejects (403 "model not available"), which looks like a CLI
      // bug rather than a catalog change.
      const inCatalog = (code?: string): boolean =>
        !!code && models.includes(code)
      const provider: RayuProvider = {
        ...existing,
        id: RAYU_HOSTED_PROVIDER_ID,
        kind: 'rayu-hosted',
        baseURL: rayuHostedBaseURL(),
        models,
        fetchedModels: models,
        defaultModel: inCatalog(existing?.defaultModel)
          ? existing?.defaultModel
          : preferredCode,
        smallFastModel: inCatalog(existing?.smallFastModel)
          ? existing?.smallFastModel
          : preferredCode,
        // Per-model context windows exactly as the admin configured them. This is
        // the map getRayuModelContextWindow() consults first, so the dashboard
        // value wins over the CLI's built-in guesses for hosted models — and a
        // model with no configured window simply isn't in the map, leaving the
        // existing fallback behaviour untouched.
        modelContextWindows: hostedContextWindows(catalog),
        // Display names exactly as the admin typed them, so /model can show
        // "DeepSeek V4 Pro" beside the id that goes on the wire.
        modelLabels: hostedModelLabels(catalog),
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

/**
 * Re-fetch entitlements and report whether the hosted model list CHANGED.
 *
 * The model picker reads the provider config synchronously, but the launch-time
 * entitlements refresh is asynchronous — so a model the admin added moments ago
 * can be missing from the list the user is looking at, which reads as "the CLI
 * didn't pick it up". Callers use this to refresh once when the picker opens and
 * re-render only if something actually moved.
 *
 * Cheap and safe: signed out, OAuth off, or inside the refresh cooldown all return
 * false without a network call, and a failure is swallowed (a picker must open
 * even when the backend is down).
 */
export async function refreshHostedCatalog(): Promise<boolean> {
  try {
    const before = hostedModelSignature()
    const { refreshRayuEntitlements } = await import('./rayuEntitlements.js')
    await refreshRayuEntitlements()
    return hostedModelSignature() !== before
  } catch {
    return false
  }
}

/** A comparable summary of what the picker would show for hosted models. */
function hostedModelSignature(): string {
  try {
    const p = loadRayuConfig().providers.find(
      (x) => x.id === RAYU_HOSTED_PROVIDER_ID,
    )
    if (!p) return ''
    // Ids + names + windows: everything the picker renders, so a rename or a
    // context-window change counts as a change too.
    return catalogSignature(p.models ?? [], p.modelLabels, p.modelContextWindows)
  } catch {
    return ''
  }
}

// The per-model label and context-window mappers moved to ./rayuModelCatalog.ts
// when the Rayu API-KEY provider ('rayu') started consuming the same catalog
// shape from GET {gateway}/v1/models. Both providers now share one
// interpretation of an admin's dashboard edits. Imported at the top of this file.

