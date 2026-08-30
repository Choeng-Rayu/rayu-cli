// Pure mappers from a Rayu model catalog to the per-model maps stored on a
// provider config (`modelLabels`, `modelContextWindows`).
//
// Shared by BOTH Rayu providers, which receive the same catalog shape from two
// different endpoints:
//   • 'rayu-hosted' (JWT)     — allowedModels/hostedModels from /me/entitlements
//   • 'rayu'        (API key) — the data[] array from GET {gateway}/v1/models
// Keeping them here means a rename or a context-window change in the admin
// dashboard is interpreted identically no matter which credential fetched it.
//
// This module is deliberately DEPENDENCY-FREE: it is imported by
// rayuHostedProvider (login path) and by the API-key catalog fetcher, and
// neither should pay for the other's imports. Pure functions only — no I/O, no
// config reads — so the whole contract is directly testable.

/**
 * The minimum a catalog entry must provide to be mapped. Both the entitlements
 * `AllowedModel` and the gateway's `/v1/models` item satisfy it structurally, so
 * neither caller has to fabricate fields it doesn't have.
 */
export type CatalogModelEntry = {
  /** Model id as it goes on the wire. */
  code: string
  /** Admin-typed display name, if any. */
  label?: string | null
  /** Admin-configured context window in tokens, if any. */
  contextWindow?: number | null
}

/**
 * Build the per-model display-name map from a catalog.
 *
 * A name is only recorded when it ADDS something: a blank label, or one that just
 * repeats the model id, is left out so the picker shows the id once instead of
 * "deepseek-v4-pro — deepseek-v4-pro". Names are trimmed but never rewritten —
 * what the admin typed is what the user sees.
 */
export function hostedModelLabels(
  catalog: ReadonlyArray<CatalogModelEntry>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of catalog) {
    const label = typeof m.label === 'string' ? m.label.trim() : ''
    if (!label || label === m.code) continue
    out[m.code] = label
  }
  return out
}

/**
 * Build the per-model context-window map from a catalog.
 *
 * Only models the admin gave a usable window are included: a missing, null, or
 * non-positive value must leave the model ABSENT from the map so the CLI keeps
 * its own default instead of budgeting against a bogus window (a 0 would make
 * every request look over-budget). Values are floored to whole tokens.
 */
export function hostedContextWindows(
  catalog: ReadonlyArray<CatalogModelEntry>,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of catalog) {
    const raw = m.contextWindow
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) continue
    out[m.code] = Math.floor(raw)
  }
  return out
}

/**
 * A comparable summary of what the model picker would render for a catalog:
 * ids + names + windows, so a rename or a context-window change counts as a
 * change too (not just an added or removed model).
 *
 * Used to decide whether a refresh actually moved anything and the picker needs
 * to re-render.
 */
export function catalogSignature(
  models: ReadonlyArray<string>,
  labels: Readonly<Record<string, string>> | undefined,
  windows: Readonly<Record<string, number>> | undefined,
): string {
  return models
    .map(m => `${m}|${labels?.[m] ?? ''}|${windows?.[m] ?? ''}`)
    .join(',')
}

/** Model ids that read as a cheap/fast tier, used to pick a small-fast default. */
const SMALL_FAST_PATTERN = /flash|mini|lite|small|haiku|air|nano/i

/**
 * Choose the default and small-fast models from an admin-controlled catalog.
 *
 * Nothing is keyed to a model NAME: the only assumption is the widely-used naming
 * convention that marks a cheap tier, and when nothing matches we reuse the
 * primary model rather than guessing. An admin can add, rename or remove models
 * freely and this still lands on something usable.
 *
 * Shared by the /connect wizard (which sets these when the key is first entered)
 * and the catalog refresh (which BACKFILLS them — the provider created from a
 * RAYU_API_KEY environment variable has no default model until a catalog is
 * known, and a provider with no default model cannot serve a request).
 */
export function pickRayuDefaultModels(models: ReadonlyArray<string>): {
  defaultModel?: string
  smallFastModel?: string
} {
  if (models.length === 0) return {}
  const primary = models.find(m => !SMALL_FAST_PATTERN.test(m)) ?? models[0]
  const small = models.find(m => SMALL_FAST_PATTERN.test(m)) ?? primary
  return { defaultModel: primary, smallFastModel: small }
}
