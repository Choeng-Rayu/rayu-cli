// THE Anthropic Messages client builder.
//
// Anthropic Messages is Rayu's internal IR: claude.ts builds an Anthropic
// Messages (beta) request and calls `beta.messages.create(...).withResponse()`.
// Several providers serve that exact wire format and differ ONLY in how they
// authenticate and which host they point at:
//
//   provider kind / surface        auth                         baseURL
//   ─────────────────────────────  ───────────────────────────  ──────────────────
//   anthropic (first-party)        x-api-key + OAuth refresh    api.anthropic.com
//   anthropic-compatible           Authorization: Bearer        provider.baseURL
//     (LongCat, Ollama Cloud)      (rotating across keys)
//   rayu-hosted                    Rayu account JWT (fetch)     gateway /anthropic
//   bedrock (Claude)               Bedrock API key (bearer)     bedrock-runtime
//   azure (Claude)                 api-key header               {resource}/anthropic
//   vertex (Claude)                Google OAuth bearer          {region}-aiplatform
//
// Before this module those variants were built at three separate `new Anthropic()`
// call sites (client.ts, anthropicCompatibleClient.ts, rayuHostedClient.ts) which
// had already drifted: rayu-hosted omitted the proxy config, the API_TIMEOUT_MS
// timeout and the standard client headers, and the third-party paths received
// first-party-only headers.
//
// SECURITY invariants enforced here:
//   • Auth and baseURL are applied AFTER the transport spread, so transport
//     options can never override credentials or the endpoint.
//   • For every non-first-party mode `apiKey` is pinned to null, so a stray
//     ANTHROPIC_API_KEY in the environment can never be sent as x-api-key to a
//     third-party host.
//   • First-party-only request decorations (ANTHROPIC_CUSTOM_HEADERS,
//     X-Claude-Code-Session-Id, x-client-request-id) are gated by the
//     `firstParty` flag — see anthropicTransport.ts.
//   • Credentials are read from the 0600 provider config and never logged.
import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk/index.js'
import { anthropicTransportOptions } from './anthropicTransport.js'
import { ROTATABLE_KEY_STATUSES } from './keyRotation.js'

/**
 * How a request to an Anthropic-Messages endpoint authenticates.
 *
 * - `x-api-key`      first-party Anthropic (the SDK's `apiKey`).
 * - `bearer`         `Authorization: Bearer <key>` via the SDK's `authToken`.
 *                    With 2+ keys the fetch rotates on rate-limit statuses.
 * - `custom-fetch`   a fetch wrapper injects the credential per request (a
 *                    refreshed JWT, an OAuth token, or a signed AWS request).
 */
export type AnthropicMessagesAuth =
  | { mode: 'x-api-key'; apiKey?: string }
  | { mode: 'bearer'; keys: string[] }
  | { mode: 'custom-fetch'; fetch: typeof fetch }

export type AnthropicMessagesClientOptions = {
  maxRetries: number
  auth: AnthropicMessagesAuth
  /** Endpoint. Omit for the SDK default (first-party api.anthropic.com). */
  baseURL?: string
  /** True ONLY for genuine first-party api.anthropic.com traffic. */
  firstParty?: boolean
  /** Query source, threaded into request debug logging. */
  source?: string
  /** Caller-supplied fetch (tests / SDK consumers). */
  fetchOverride?: ClientOptions['fetch']
  /** Additional default headers (first-party container/session/app headers). */
  extraHeaders?: Record<string, string>
  /**
   * Wrap the resolved fetch — used for Rayu gateway routing, which must sit
   * OUTSIDE the auth/logging fetch so it can fail safe back to a direct call.
   */
  wrapFetch?: (inner: typeof fetch) => typeof fetch
}

/**
 * Wrap a base fetch so requests rotate across multiple Bearer API keys: it
 * overwrites the `Authorization` header with the current key, and on a rotatable
 * status (429/402/401/403 — see keyRotation.ts) re-issues the SAME request with
 * the next key, looping through all of them. A key that succeeds becomes the
 * sticky start for later requests, so we don't re-hit an exhausted key every
 * time. When every key is exhausted the last response is returned (the SDK then
 * throws, and the shared retry layer backs off and re-enters this loop).
 *
 * This is the Anthropic-Messages analogue of the OpenAI adapter's
 * withKeyRotation — done at the fetch layer because these providers use the
 * native Anthropic SDK client (a single authToken) rather than one client per
 * key. Safe to re-issue because the Anthropic SDK sends a string JSON body
 * (reusable across attempts); only the Authorization header changes.
 */
export function makeKeyRotatingFetch(
  keys: string[],
  baseFetch: typeof fetch,
): typeof fetch {
  let current = 0
  const rotating = (async (input, init) => {
    const n = keys.length
    let lastResp: Response | undefined
    for (let attempt = 0; attempt < n; attempt++) {
      const idx = (current + attempt) % n
      const headers = new Headers(init?.headers)
      headers.set('Authorization', `Bearer ${keys[idx]}`)
      const resp = await baseFetch(input, { ...init, headers })
      if (
        resp.ok ||
        attempt === n - 1 ||
        !ROTATABLE_KEY_STATUSES.has(resp.status)
      ) {
        if (resp.ok) current = idx
        return resp
      }
      // This key is rate-limited/exhausted — drain its body and try the next.
      try {
        await resp.body?.cancel()
      } catch {
        // ignore — best-effort cleanup before rotating
      }
      lastResp = resp
    }
    return lastResp as Response
  }) as typeof fetch
  return rotating
}

/**
 * Build a native Anthropic SDK client for any provider that speaks the Anthropic
 * Messages wire format.
 */
export function createAnthropicMessagesClient(
  opts: AnthropicMessagesClientOptions,
): Anthropic {
  const {
    auth,
    baseURL,
    maxRetries,
    firstParty = false,
    source,
    fetchOverride,
    extraHeaders,
    wrapFetch,
  } = opts

  const transport = anthropicTransportOptions({
    firstParty,
    source,
    // `custom-fetch` auth supplies the credential-injecting fetch; it becomes the
    // inner fetch of the transport's logging wrapper so both apply.
    fetchOverride:
      auth.mode === 'custom-fetch'
        ? (auth.fetch as ClientOptions['fetch'])
        : fetchOverride,
  })

  // Multi-key rotation wraps the transport fetch (which already carries request
  // logging), so a rotated attempt is logged like any other request.
  const keys =
    auth.mode === 'bearer'
      ? auth.keys.map(k => k?.trim()).filter((k): k is string => !!k)
      : []
  let resolvedFetch = transport.fetch as typeof fetch | undefined
  if (keys.length > 1) {
    resolvedFetch = makeKeyRotatingFetch(
      keys,
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      (resolvedFetch ?? globalThis.fetch) as typeof fetch,
    )
  }
  if (wrapFetch) {
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    resolvedFetch = wrapFetch((resolvedFetch ?? globalThis.fetch) as typeof fetch)
  }

  // Final default headers: the shared transport's, then any caller extras, then
  // the auth header for Bearer mode.
  //
  // The explicit Bearer header is required, not redundant: @anthropic-ai/sdk
  // merges ANTHROPIC_CUSTOM_HEADERS into defaultHeaders itself, and defaultHeaders
  // take precedence over the `authToken`-derived Authorization header — so a
  // corporate `ANTHROPIC_CUSTOM_HEADERS="Authorization: …"` would otherwise
  // REPLACE the provider's own key (verified in test). anthropicTransport nulls
  // those env headers out for third-party clients; we then set the provider's own
  // credential here so it is unambiguously the one on the wire.
  const defaultHeaders: Record<string, string | null> = {
    ...(transport.defaultHeaders as Record<string, string | null>),
    ...(extraHeaders ?? {}),
    ...(auth.mode === 'bearer' && keys[0]
      ? { Authorization: `Bearer ${keys[0]}` }
      : {}),
  }

  const config: ConstructorParameters<typeof Anthropic>[0] = {
    dangerouslyAllowBrowser: true,
    ...transport,
    defaultHeaders: defaultHeaders as ClientOptions['defaultHeaders'],
    ...(resolvedFetch ? { fetch: resolvedFetch as ClientOptions['fetch'] } : {}),
    // Auth + endpoint + retries LAST so the transport can never override them.
    ...resolveAuthFields(auth, keys),
    ...(baseURL ? { baseURL } : {}),
    maxRetries,
  }

  return new Anthropic(config)
}

/**
 * Map an auth descriptor onto the SDK's credential fields.
 *
 * SECURITY: every non-first-party mode pins `apiKey: null`. Without it the SDK
 * falls back to `process.env.ANTHROPIC_API_KEY` and would send a first-party
 * key as `x-api-key` to a third-party host.
 */
function resolveAuthFields(
  auth: AnthropicMessagesAuth,
  keys: string[],
): { apiKey?: string | null; authToken?: string | null } {
  switch (auth.mode) {
    case 'x-api-key':
      return { apiKey: auth.apiKey || undefined }
    case 'bearer':
      return { apiKey: null, authToken: keys[0] ?? null }
    case 'custom-fetch':
      // The fetch wrapper sets Authorization itself; the SDK needs a non-empty
      // `apiKey` to avoid its "missing credentials" error. The placeholder is
      // sent as x-api-key and ignored by the endpoint — it is never a real key.
      return { apiKey: 'rayu' }
  }
}
