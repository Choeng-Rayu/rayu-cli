// Anthropic-compatible BYO-key client. Some third-party providers (e.g. LongCat,
// Ollama Cloud) expose the Anthropic Messages API at a CUSTOM base URL,
// authenticated with `Authorization: Bearer <key>` rather than the first-party
// `x-api-key`. Rayu talks to them with the NATIVE Anthropic SDK — no
// OpenAI↔Anthropic translation layer — pointed at the provider's baseURL, with
// the user's key sent as a Bearer authToken. Thinking, tools, and native
// usage/cache reporting all map 1:1 with claude.ts.
//
// This is the SAME Anthropic call path the first-party 'anthropic' provider uses
// (client.ts → getAnthropicClient). The caller (client.ts) passes the identical
// transport options first-party uses — default headers (User-Agent + session id
// + ANTHROPIC_CUSTOM_HEADERS), the 600s timeout, proxy fetch options, an optional
// debug logger — so the only differences from first-party are the baseURL and
// Bearer auth. First-party-only concerns (OAuth refresh, x-api-key, rayu-gateway
// active-user routing) are intentionally excluded.
//
// Lazy-imported by client.ts when the active (or routed) provider is
// kind:'anthropic-compatible'.
import Anthropic from '@anthropic-ai/sdk'
import type { ClientOptions } from '@anthropic-ai/sdk/index.js'
import type { RayuProvider } from '../../utils/rayuConfig.js'

// HTTP statuses that mean "this key can't serve the request right now, but a
// DIFFERENT key might" — so the rotating fetch retries with the next stored key:
//   429 Too Many Requests (rate limit / quota) · 402 Payment Required (out of
//   credits) · 401 Unauthorized (bad/expired key) · 403 Forbidden (key quota).
// 404 is intentionally excluded (not-found is not a per-key problem).
const ROTATABLE_KEY_STATUSES: ReadonlySet<number> = new Set([429, 402, 401, 403])

/**
 * Wrap a base fetch so requests rotate across multiple Bearer API keys: it
 * overwrites the `Authorization` header with the current key, and on a rotatable
 * status (429/402/401/403) re-issues the SAME request with the next key,
 * looping through all of them. A key that succeeds becomes the sticky start for
 * later requests, so we don't re-hit an exhausted key every time. When every
 * key is exhausted the last response is returned (the SDK then throws, and the
 * shared retry layer backs off and re-enters this loop).
 *
 * This is the anthropic-compatible analogue of the OpenAI adapter's
 * withKeyRotation — done at the fetch layer because these providers use the
 * native Anthropic SDK client (single authToken) rather than our custom adapter.
 * Safe to re-issue because the Anthropic SDK sends a string JSON body (reusable
 * across attempts); only the Authorization header changes between keys.
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
 * Build a native Anthropic SDK client for an Anthropic-compatible BYO-key
 * provider (LongCat, Ollama Cloud, …). The user's key is sent as a Bearer token
 * (`authToken`) because these endpoints authenticate via `Authorization: Bearer`,
 * not `x-api-key`. `apiKey` is pinned to null so a stray ANTHROPIC_API_KEY in the
 * environment is never leaked to a third-party host and the SDK doesn't fall back
 * to the first-party api.anthropic.com key.
 *
 * `transport` carries the shared Anthropic transport options (headers, proxy
 * fetchOptions, timeout, logger, fetch) computed by the caller to match the
 * first-party client. Auth + endpoint + maxRetries are applied AFTER the spread
 * so transport can never override them.
 *
 * `apiKeys` (optional) enables MULTI-KEY rate-limit failover: when 2+ keys are
 * supplied, the client's fetch rotates across them (makeKeyRotatingFetch) and
 * authToken is pinned to the first key. With 0/1 keys it behaves exactly as
 * before (single authToken). The caller (client.ts) resolves + gates this list
 * (paid-plan only) so a Free user always gets a single key.
 *
 * SECURITY: provider.apiKey / apiKeys are secrets read from the 0600 config;
 * never logged.
 */
export function createAnthropicCompatibleClient(
  provider: RayuProvider,
  maxRetries: number,
  transport: Partial<ClientOptions> = {},
  apiKeys?: string[],
): Anthropic {
  const keys = (apiKeys ?? [])
    .map(k => k?.trim())
    .filter((k): k is string => !!k)
  const rotate = keys.length > 1
  const finalTransport: Partial<ClientOptions> = rotate
    ? {
        ...transport,
        fetch: makeKeyRotatingFetch(
          keys,
          (transport.fetch ?? (globalThis.fetch as typeof fetch)) as typeof fetch,
        ) as ClientOptions['fetch'],
      }
    : transport
  return new Anthropic({
    dangerouslyAllowBrowser: true,
    ...finalTransport,
    apiKey: null,
    authToken: keys[0] ?? provider.apiKey,
    baseURL: provider.baseURL,
    maxRetries,
  })
}
