// Rayu-hosted client. The Rayu gateway speaks the OpenAI Chat Completions API,
// so we reuse the OpenAI-compatible adapter verbatim and only swap in a custom
// `fetch` that injects the user's Rayu JWT (see rayuHostedAuth). Lazy-imported
// by client.ts when the active (or routed) provider is kind:'rayu-hosted'.
import type { RayuProvider } from '../../../utils/rayuConfig.js'
import { createOpenAICompatibleClient } from '../openaiAdapter.js'
import { makeRayuHostedFetch, rayuHostedBaseURL } from './rayuHostedAuth.js'

/**
 * Build a Rayu-hosted client (OpenAI adapter + Rayu JWT fetch wrapper). The
 * provider needs no API key — auth is the account JWT injected by the fetch
 * wrapper; the gateway holds the real upstream provider key.
 */
export function createRayuHostedClient(provider: RayuProvider, maxRetries: number) {
  return createOpenAICompatibleClient({
    // Auth is handled entirely by the custom fetch; apiKey is a placeholder.
    apiKey: 'rayu',
    baseURL: provider.baseURL || rayuHostedBaseURL(),
    fetch: makeRayuHostedFetch(),
    providerId: provider.id,
    maxRetries,
    promptCacheKey: provider.promptCacheKey,
    reasoningEffort: provider.reasoningEffort,
    streamOptions: provider.streamOptions,
  })
}
