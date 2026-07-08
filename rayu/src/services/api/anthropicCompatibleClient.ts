// Anthropic-compatible BYO-key client. Some third-party providers (e.g. LongCat)
// expose the Anthropic Messages API at a CUSTOM base URL, authenticated with
// `Authorization: Bearer <key>` rather than the first-party `x-api-key`. Rayu
// talks to them with the NATIVE Anthropic SDK — no OpenAI↔Anthropic translation
// layer — pointed at the provider's baseURL, with the user's key sent as a
// Bearer authToken. Thinking, tools, and native usage/cache reporting all map
// 1:1 with claude.ts (the same path first-party Anthropic + rayu-hosted use).
//
// Lazy-imported by client.ts when the active (or routed) provider is
// kind:'anthropic-compatible'.
import Anthropic from '@anthropic-ai/sdk'
import type { RayuProvider } from '../../utils/rayuConfig.js'

/**
 * Build a native Anthropic SDK client for an Anthropic-compatible BYO-key
 * provider (LongCat, …). The user's key is sent as a Bearer token (`authToken`)
 * because these endpoints authenticate via `Authorization: Bearer`, not
 * `x-api-key`. `apiKey` is pinned to null so a stray ANTHROPIC_API_KEY in the
 * environment is never leaked to a third-party host as an x-api-key header, and
 * the SDK doesn't fall back to the first-party api.anthropic.com key.
 *
 * SECURITY: provider.apiKey is a secret read from the 0600 config; never logged.
 */
export function createAnthropicCompatibleClient(
  provider: RayuProvider,
  maxRetries: number,
): Anthropic {
  return new Anthropic({
    apiKey: null,
    authToken: provider.apiKey,
    baseURL: provider.baseURL,
    maxRetries,
  })
}
