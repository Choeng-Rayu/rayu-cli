// Model catalog for the Rayu API-KEY provider ('rayu').
//
// Fetches GET {gateway}/v1/models with the user's `rayu_sk_live_…` key. The
// gateway returns the caller's plan-allowed catalog in OpenAI list shape, with
// the admin's own display name and context window on every entry:
//
//   { "object": "list", "data": [
//       { "id": "deepseek-v3", "object": "model", "owned_by": "rayu",
//         "label": "DeepSeek V3", "supportsReasoning": true,
//         "supportsImage": false, "supportsTools": true,
//         "contextWindow": 131072 }, … ] }
//
// Nothing about the catalog is hardcoded in the CLI: adding, renaming, removing
// a model or changing its context window in the admin dashboard shows up on the
// next fetch with no CLI release. That is the whole point of this module.
//
// The CATALOG lives on the gateway's OpenAI-shaped `/v1` surface, while CHAT for
// this provider goes to `/anthropic/v1/messages` — so this deliberately does NOT
// derive its URL from `provider.baseURL` (which points at `/anthropic`).
//
// SECURITY: the key is sent only to the Rayu gateway, as a Bearer credential,
// and is never logged — not in the diagnostics payloads below, not in errors.
import { getRayuGatewayBaseUrl } from '../../rayuAuth/rayuSession.js'
import {
  hostedContextWindows,
  hostedModelLabels,
  type CatalogModelEntry,
} from '../../rayuAuth/rayuModelCatalog.js'
import { sanitizeRemoteModelId } from '../../../utils/rayuConfig.js'
import { reportIssue } from '../../../utils/rayuDiagnostics.js'

/** Matches the 15s budget the other provider catalog fetches use. */
const CATALOG_TIMEOUT_MS = 15_000

/** One entry of the gateway's `/v1/models` response, as far as we rely on it. */
type GatewayModelItem = {
  id?: unknown
  label?: unknown
  contextWindow?: unknown
}

/**
 * Why a catalog fetch failed, so the caller can tell a bad key from a bad day.
 *
 * Mirrors the gateway's own distinctions (crates/gateway/src/auth.rs):
 *   • 'invalid'     — 401, the key is unknown, revoked or expired.
 *   • 'forbidden'   — 403, the ACCOUNT is inactive ("account is …"); the key
 *                     itself is fine, so prompting for a new one is wrong.
 *   • 'unavailable' — 503 / network / timeout. NOT the user's fault: the gateway
 *                     returns 503 "authentication temporarily unavailable" when
 *                     its database is down, and treating that as a bad key would
 *                     have users rotate perfectly good credentials.
 */
export type RayuCatalogFailure = 'invalid' | 'forbidden' | 'unavailable'

export type RayuCatalogResult =
  | {
      ok: true
      /** Sanitized model ids, sorted, in picker order. */
      models: string[]
      /** Admin display names, keyed by model id (absent when none was set). */
      modelLabels: Record<string, string>
      /** Admin context windows in tokens, keyed by model id. */
      modelContextWindows: Record<string, number>
    }
  | { ok: false; reason: RayuCatalogFailure }

/** The gateway endpoint that serves the catalog (NOT the provider's baseURL). */
function catalogURL(): string {
  return `${getRayuGatewayBaseUrl()}/v1/models`
}

/**
 * Map an HTTP status onto a failure reason. Anything unexpected is treated as
 * `unavailable` rather than `invalid`: refusing a working key on a status we did
 * not anticipate is the more damaging error of the two.
 */
function failureForStatus(status: number): RayuCatalogFailure {
  if (status === 401) return 'invalid'
  if (status === 403) return 'forbidden'
  return 'unavailable'
}

/**
 * Parse the catalog payload into the maps a provider config stores.
 *
 * Exported for tests, and kept pure so the mapping can be asserted without HTTP.
 *
 * SECURITY: every id goes through `sanitizeRemoteModelId`. A catalog response is
 * untrusted input, and `encodeModelWithProvider` joins provider and model with
 * `\u0000` — so an id containing that separator could spoof provider routing and
 * send a request somewhere the user never selected. Unusable ids are dropped
 * rather than repaired.
 */
export function parseRayuCatalog(payload: unknown): {
  models: string[]
  modelLabels: Record<string, string>
  modelContextWindows: Record<string, number>
} {
  const data = (payload as { data?: unknown })?.data
  const items: GatewayModelItem[] = Array.isArray(data) ? data : []
  const entries: CatalogModelEntry[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const code = sanitizeRemoteModelId(item?.id)
    if (!code || seen.has(code)) continue
    seen.add(code)
    entries.push({
      code,
      label: typeof item.label === 'string' ? item.label : null,
      contextWindow:
        typeof item.contextWindow === 'number' ? item.contextWindow : null,
    })
  }
  return {
    models: entries.map(e => e.code).sort(),
    modelLabels: hostedModelLabels(entries),
    modelContextWindows: hostedContextWindows(entries),
  }
}

/**
 * Fetch the catalog the given API key is entitled to.
 *
 * Never throws: a transport failure resolves to `{ok:false, reason:'unavailable'}`
 * so callers can fail open (keep a cached catalog, let the user proceed) instead
 * of handling exceptions on the connect and launch paths.
 */
export async function fetchRayuApiKeyCatalog(
  apiKey: string | undefined,
): Promise<RayuCatalogResult> {
  const key = apiKey?.trim()
  if (!key) return { ok: false, reason: 'invalid' }
  try {
    const res = await (globalThis.fetch as typeof fetch)(catalogURL(), {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    })
    if (!res.ok) {
      const reason = failureForStatus(res.status)
      // Status only — never the key, and never the response body, which can echo
      // account details.
      reportIssue('rayu_catalog.fetch_failed', 'rayu /v1/models returned non-OK', {
        status: res.status,
        reason,
      })
      return { ok: false, reason }
    }
    return { ok: true, ...parseRayuCatalog(await res.json()) }
  } catch (e) {
    reportIssue('rayu_catalog.fetch_error', 'rayu /v1/models request failed', {
      error: e instanceof Error ? e.message : String(e),
    })
    return { ok: false, reason: 'unavailable' }
  }
}
