// Rayu-hosted client. rayu-hosted models are served by DeepSeek's
// Anthropic-compatible API (https://api.deepseek.com/anthropic) through the Rayu
// gateway, so we use the NATIVE Anthropic SDK — no OpenAI↔Anthropic translation
// layer — pointed at the gateway's /anthropic base. The gateway forwards to
// DeepSeek's Anthropic endpoint with its server-side key and meters credits off
// the native Anthropic usage. Prompt-cache usage (cache_read_input_tokens) comes
// back natively, so thinking/tools/usage all map 1:1 with claude.ts.
//
// Lazy-imported by client.ts when the active (or routed) provider is
// kind:'rayu-hosted'.
import Anthropic from '@anthropic-ai/sdk'
import type { RayuProvider } from '../../../utils/rayuConfig.js'
import { makeRayuHostedFetch, rayuHostedAnthropicBaseURL } from './rayuHostedAuth.js'

/**
 * Build a Rayu-hosted client (native Anthropic SDK + Rayu JWT fetch wrapper).
 * The provider needs no API key — auth is the account JWT injected per-request
 * by the custom fetch (as `Authorization: Bearer`); the gateway holds the real
 * upstream provider key. The `apiKey` below is a placeholder the SDK requires;
 * it is sent as `x-api-key`, which the gateway ignores in favor of the JWT.
 */
export function createRayuHostedClient(_provider: RayuProvider, maxRetries: number) {
  return new Anthropic({
    apiKey: 'rayu',
    baseURL: rayuHostedAnthropicBaseURL(),
    fetch: makeRayuHostedFetch(),
    maxRetries,
  })
}
