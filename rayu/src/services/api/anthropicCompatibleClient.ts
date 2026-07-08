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
 * SECURITY: provider.apiKey is a secret read from the 0600 config; never logged.
 */
export function createAnthropicCompatibleClient(
  provider: RayuProvider,
  maxRetries: number,
  transport: Partial<ClientOptions> = {},
): Anthropic {
  return new Anthropic({
    dangerouslyAllowBrowser: true,
    ...transport,
    apiKey: null,
    authToken: provider.apiKey,
    baseURL: provider.baseURL,
    maxRetries,
  })
}
