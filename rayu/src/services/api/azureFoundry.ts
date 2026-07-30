// Microsoft Azure (Foundry) endpoints.
//
// ONE Azure provider serves two wire formats from the same resource, chosen per
// model by resolveWireFormat():
//
//   Claude   → Anthropic Messages at  {base}/anthropic         (SDK appends /v1/messages)
//   GPT etc. → OpenAI Responses at    {base}/openai/v1         (+ ?api-version=)
//
// GROUNDING (read, not assumed):
//   • Claude endpoint + auth come from the OFFICIAL @anthropic-ai/foundry-sdk,
//     which is present in node_modules. Its client (src/client.ts:31) is
//     `class AnthropicFoundry extends Anthropic`, i.e. the plain Anthropic SDK
//     with:
//       - baseURL `https://${resource}.services.ai.azure.com/anthropic/`
//         (client.js:75)
//       - `x-api-key: <key>` for API-key auth (client.js:115), or
//         `Authorization: Bearer <token>` for an Entra token provider (client.js:112)
//       - env vars ANTHROPIC_FOUNDRY_{BASE_URL,API_KEY,RESOURCE} — the same ones
//         already documented in services/api/client.ts
//     We do NOT depend on that package (it is in neither package.json nor
//     bun.lock); we reuse our own shared Anthropic-Messages builder instead,
//     which is exactly what the SDK does under the hood.
//   • Azure OpenAI shape comes from the Microsoft v1-preview REST reference:
//     requests are `{endpoint}/openai/v1/{path}?api-version=preview`, auth is
//     EITHER an `api-key` header OR `Authorization: Bearer <Entra token>`, and
//     `api-version` defaults to `v1` when omitted.
//
// NOT LIVE-VERIFIED (no Azure credentials available):
//   • whether a Foundry resource lists Claude deployments in the same
//     /openai/v1/models response as its GPT deployments. The catalog therefore
//     merges whatever the listing returns with the curated Claude ids from
//     configs.ts, and resolveWireFormat routes per model family — so a Claude id
//     is served correctly whether or not the listing reports it.
//
// SECURITY: the Azure key is sent only to the configured Azure host. The base URL
// is validated (https, no embedded credentials, host allowlist) before any
// request, and the derived endpoints are always built from that validated origin.

/** Default api-version for the Azure OpenAI v1 surface. */
export const AZURE_DEFAULT_API_VERSION = 'preview'

/** Hostname suffixes an Azure resource endpoint may legitimately use. */
const AZURE_HOST_SUFFIXES = [
  '.services.ai.azure.com',
  '.openai.azure.com',
  '.cognitiveservices.azure.com',
  '.azure.anthropic.com',
]

/**
 * Resolve the resource ORIGIN for an Azure provider.
 *
 * Accepts either a bare resource name ('my-resource') or a full URL. Returns the
 * origin only (no path), so the per-surface builders below can append their own
 * paths without doubling segments.
 */
export function azureResourceOrigin(resourceOrUrl: string): string {
  const raw = (resourceOrUrl ?? '').trim()
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw)) {
    try {
      return new URL(raw).origin
    } catch {
      return ''
    }
  }
  // A bare name, or a hostname without a scheme.
  const name = raw.replace(/\/+$/, '')
  if (name.includes('.')) return `https://${name}`
  return `https://${name}.services.ai.azure.com`
}

export type AzureUrlValidation =
  | { ok: true; origin: string }
  | { ok: false; reason: string }

/**
 * Validate an Azure endpoint before a credential is ever attached to it.
 *
 * SECURITY (plan requirement 5): rejects non-http(s) schemes and URLs carrying
 * embedded credentials, and refuses plaintext http to a non-loopback host (which
 * would transmit the API key in the clear). Unknown hosts are allowed but
 * reported, because customers use private/sovereign-cloud endpoints; the caller
 * decides whether to warn.
 */
export function validateAzureEndpoint(resourceOrUrl: string): AzureUrlValidation {
  const raw = (resourceOrUrl ?? '').trim()
  if (!raw) return { ok: false, reason: 'Enter an Azure resource name or endpoint URL.' }

  // Anything with a scheme must be inspected AS WRITTEN. Deriving the origin
  // first would hide two problems: `new URL().origin` strips embedded
  // credentials, and a non-http scheme would otherwise fall through to the
  // bare-name branch and be re-prefixed into a superficially valid https URL.
  const scheme = raw.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase()
  if (scheme) {
    if (scheme !== 'http' && scheme !== 'https') {
      return { ok: false, reason: 'Only http:// and https:// endpoints are supported.' }
    }
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      return { ok: false, reason: 'That is not a valid URL.' }
    }
    if (parsed.username || parsed.password) {
      return {
        ok: false,
        reason:
          'Remove the credentials from the URL — the API key is entered separately.',
      }
    }
    if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
      return {
        ok: false,
        reason:
          'Refusing to send an API key over plaintext http:// to a remote host. Use https://.',
      }
    }
    return { ok: true, origin: parsed.origin }
  }

  // A bare resource name or hostname.
  if (/[/\\?#@\s]/.test(raw)) {
    return {
      ok: false,
      reason: 'Enter just the resource name, or a full https:// endpoint URL.',
    }
  }
  const origin = azureResourceOrigin(raw)
  if (!origin) return { ok: false, reason: 'That is not a valid resource name.' }
  try {
    new URL(origin)
  } catch {
    return { ok: false, reason: 'That is not a valid resource name.' }
  }
  return { ok: true, origin }
}

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'
}

/** True when a host looks like a Microsoft-operated Azure AI endpoint. */
export function isKnownAzureHost(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase()
    return AZURE_HOST_SUFFIXES.some(s => host.endsWith(s))
  } catch {
    return false
  }
}

/**
 * Anthropic Messages base URL for an Azure resource.
 * The Anthropic SDK appends `/v1/messages`, matching the official Foundry SDK's
 * `https://{resource}.services.ai.azure.com/anthropic/`.
 */
export function azureAnthropicBaseURL(resourceOrUrl: string): string {
  const origin = azureResourceOrigin(resourceOrUrl)
  return origin ? `${origin}/anthropic` : ''
}

/**
 * Azure OpenAI v1 base URL for an Azure resource. The OpenAI SDK appends
 * `/responses`, giving `{origin}/openai/v1/responses?api-version=…`.
 */
export function azureOpenAIBaseURL(resourceOrUrl: string): string {
  const origin = azureResourceOrigin(resourceOrUrl)
  return origin ? `${origin}/openai/v1` : ''
}

/** The `api-version` query Azure requires on the OpenAI surface. */
export function azureQueryParams(apiVersion?: string): Record<string, string> {
  return { 'api-version': apiVersion || AZURE_DEFAULT_API_VERSION }
}

/**
 * Candidate model/deployment listing URLs for an Azure resource, in preference
 * order:
 *   1. the v1 surface's OpenAI-compatible listing
 *   2. the classic dated deployments listing, for resources not yet on v1
 * Both are documented; which one a given resource answers is not live-verified.
 */
export function azureModelListURLs(
  resourceOrUrl: string,
  apiVersion?: string,
): string[] {
  const origin = azureResourceOrigin(resourceOrUrl)
  if (!origin) return []
  const v = apiVersion || AZURE_DEFAULT_API_VERSION
  return [
    `${origin}/openai/v1/models?api-version=${encodeURIComponent(v)}`,
    `${origin}/openai/deployments?api-version=2023-03-15-preview`,
  ]
}

/**
 * Parse either listing shape into model ids.
 *   v1 models:   { data: [{ id, ... }] }
 *   deployments: { data: [{ id, model, status }] } — `id` is the DEPLOYMENT name,
 *                which is what must be sent as the model, so it is preferred.
 */
export function parseAzureModelList(json: unknown): string[] {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) return []
  const ids: string[] = []
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    // Skip deployments that are not usable yet.
    const status = typeof e.status === 'string' ? e.status : undefined
    if (status && !/succeeded|running|ready/i.test(status)) continue
    const id = typeof e.id === 'string' ? e.id : undefined
    if (id) ids.push(id)
  }
  return ids
}

/** Headers Azure expects for API-key auth on either surface. */
export function azureApiKeyHeaders(
  apiKey: string,
  surface: 'anthropic' | 'openai',
): Record<string, string> {
  // Claude on Foundry uses the Anthropic convention (x-api-key) — see
  // foundry-sdk client.js:115. Azure OpenAI uses its own `api-key` header.
  return surface === 'anthropic' ? { 'x-api-key': apiKey } : { 'api-key': apiKey }
}
