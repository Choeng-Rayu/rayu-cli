// Rayu GitHub Copilot client. Copilot speaks the OpenAI Chat Completions API on
// api.githubcopilot.com, so we reuse the OpenAI-compatible adapter verbatim and
// only swap in a custom `fetch` that injects a fresh short-lived Copilot token
// (refreshed from the stored GitHub OAuth token) + the editor headers on every
// request — exactly how the Vertex provider reuses the adapter with an OAuth
// fetch wrapper. Lazy-imported by client.ts only when the active (or routed)
// provider is kind:'copilot'. SECURITY: tokens are never logged.
import type { RayuProvider } from '../../../utils/rayuConfig.js'
import { createOpenAICompatibleClient } from '../openaiAdapter.js'
import { COPILOT_BASE_URL, COPILOT_EDITOR_HEADERS, makeCopilotFetch } from './copilotAuth.js'

/**
 * Build a GitHub Copilot client (OpenAI adapter + Copilot OAuth fetch wrapper).
 * The provider's apiKey holds the long-lived GitHub OAuth token from /connect.
 */
export function createCopilotClient(provider: RayuProvider, maxRetries: number) {
  const githubToken = provider.apiKey
  if (!githubToken) {
    throw new Error(
      'Not signed in to GitHub Copilot. Run /connect → GitHub Copilot to sign in.',
    )
  }
  return createOpenAICompatibleClient({
    // Auth is handled entirely by the custom fetch; apiKey is a placeholder.
    apiKey: 'copilot',
    baseURL: COPILOT_BASE_URL,
    headers: { ...COPILOT_EDITOR_HEADERS },
    fetch: makeCopilotFetch(githubToken),
    providerId: provider.id,
    maxRetries,
    promptCacheKey: provider.promptCacheKey,
    reasoningEffort: provider.reasoningEffort,
    streamOptions: provider.streamOptions,
  })
}
