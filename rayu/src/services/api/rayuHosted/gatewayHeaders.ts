// Shared X-Rayu-* request-identity + model-metadata headers for gateway-routed
// and Rayu-hosted requests. These let the gateway log the REAL model, attribute
// traffic to a query source, and correlate retries by a logical request id.
//
// SECURITY / FIDELITY NOTES:
//  - The gateway strips every `X-Rayu-*` header before forwarding upstream
//    (see forwardableHeaders in rayu-gateway), so none of these ever reach the
//    provider (AWS Bedrock / DeepSeek / …).
//  - `resolved`/`canonical` are derived from the ACTUAL outgoing request (URL
//    for Bedrock, body for OpenAI/Anthropic), so they are authoritative — the
//    gateway compares them against `intended` to detect a fidelity break.
import { getCanonicalName } from '../../../utils/model/model.js'

/** Per-attempt unique id (one physical HTTP request). */
export const RAYU_REQUEST_ID_HEADER = 'x-rayu-request-id'
/** Stable id shared across retries of the SAME logical request (turn accounting). */
export const RAYU_LOGICAL_REQUEST_ID_HEADER = 'x-rayu-logical-request-id'
/** The model the caller INTENDED (user selection / subagent config), canonicalized. */
export const RAYU_INTENDED_MODEL_HEADER = 'x-rayu-intended-model'
/** The model actually placed on the wire (Bedrock URL path or request body). */
export const RAYU_RESOLVED_MODEL_HEADER = 'x-rayu-resolved-model'
/** Canonical family/version of the resolved model (e.g. claude-opus-4-6). */
export const RAYU_CANONICAL_MODEL_HEADER = 'x-rayu-canonical-model'
/** Logical origin of the request (repl_main_thread, agent:*, compact, …). */
export const RAYU_QUERY_SOURCE_HEADER = 'x-rayu-query-source'

/**
 * Extract the model id from a Bedrock invoke URL. The AnthropicBedrock SDK
 * moves the model out of the JSON body and into the path:
 *   /model/{id}/invoke
 *   /model/{id}/invoke-with-response-stream
 * Returns '' when the URL is not a Bedrock invoke URL.
 */
export function modelFromBedrockUrl(url: string): string {
  const m = url.match(
    /\/model\/([^/]+)\/invoke(?:-with-response-stream)?(?:$|\?|#)/,
  )
  return m?.[1] ? decodeURIComponent(m[1]) : ''
}

/** Pull the `model` field out of a JSON request body (best-effort). */
function modelFromBody(body: unknown): string {
  if (typeof body !== 'string' || body.length === 0) {
    return ''
  }
  try {
    const parsed = JSON.parse(body) as { model?: unknown }
    return typeof parsed.model === 'string' ? parsed.model : ''
  } catch {
    return ''
  }
}

/**
 * The model that is ACTUALLY going on the wire for this request: the Bedrock URL
 * path first (authoritative for Bedrock, where the body has no model), else the
 * JSON body's `model`. Returns '' when it can't be determined.
 */
export function resolvedModelFromRequest(
  upstreamUrl: string,
  body: unknown,
): string {
  return modelFromBedrockUrl(upstreamUrl) || modelFromBody(body)
}

/**
 * Compute the authoritative model-metadata headers to attach to a
 * gateway-routed request. `intended`/`logicalRequestId`/`querySource` are
 * best-effort passthroughs from the caller (claude.ts) and are backfilled when
 * absent so the gateway always sees a complete, self-consistent set.
 */
export function buildModelMetadataHeaders(params: {
  upstreamUrl: string
  body: unknown
  requestId: string
  intended?: string | null
  logicalRequestId?: string | null
  querySource?: string | null
}): Record<string, string> {
  const resolved = resolvedModelFromRequest(params.upstreamUrl, params.body)
  const canonical = resolved ? safeCanonical(resolved) : ''
  const intended = (params.intended || canonical || resolved || '').trim()
  const out: Record<string, string> = {
    [RAYU_REQUEST_ID_HEADER]: params.requestId,
    [RAYU_LOGICAL_REQUEST_ID_HEADER]:
      (params.logicalRequestId || params.requestId).trim(),
  }
  if (resolved) out[RAYU_RESOLVED_MODEL_HEADER] = resolved
  if (canonical) out[RAYU_CANONICAL_MODEL_HEADER] = canonical
  if (intended) out[RAYU_INTENDED_MODEL_HEADER] = intended
  if (params.querySource) out[RAYU_QUERY_SOURCE_HEADER] = params.querySource
  return out
}

function safeCanonical(model: string): string {
  try {
    return getCanonicalName(model)
  } catch {
    return ''
  }
}
