// Builds an OpenAI-compatible adapter client for Gemini on Google Vertex AI.
//
// Vertex's Chat Completions endpoint speaks the OpenAI wire format but (a)
// authenticates with a short-lived Google Cloud OAuth bearer token rather than
// a static API key, and (b) expects model ids carrying a `google/` publisher
// prefix. We satisfy both with a fetch wrapper around the OpenAI SDK: it mints
// a fresh token per request and rewrites the JSON body's `model` field.
//
// SECURITY: the bearer token is injected only into requests to the Vertex host
// and is never logged.
import type { RayuProvider } from '../../../utils/rayuConfig.js'
import { vertexBaseURL, DEFAULT_VERTEX_REGION } from '../../../utils/rayuProviders.js'
import { createOpenAICompatibleClient } from '../openaiAdapter.js'
import { getVertexAccessToken } from './vertexAuth.js'

/** Prefix a bare model id with the Vertex `google/` publisher namespace. */
export function toVertexModelId(model: string): string {
  if (!model) return model
  // Already publisher-qualified (google/…, publishers/google/…, etc.).
  if (model.includes('/')) return model
  return `google/${model}`
}

/**
 * A fetch wrapper that injects a fresh Vertex OAuth bearer token and rewrites
 * the request body's `model` to the `google/<id>` form. Exported for testing.
 */
export function buildVertexFetch(
  getToken: () => Promise<string> = getVertexAccessToken,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const token = await getToken()
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${token}`)

    let body = init?.body
    if (typeof body === 'string' && body.length > 0) {
      try {
        const parsed = JSON.parse(body) as { model?: unknown }
        if (typeof parsed.model === 'string') {
          parsed.model = toVertexModelId(parsed.model)
          body = JSON.stringify(parsed)
        }
      } catch {
        // Non-JSON body — leave untouched.
      }
    }
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    return globalThis.fetch(input, { ...init, headers, body })
  }) as unknown as typeof fetch
}

/**
 * Build a Vertex Gemini chat client for the given provider config. Returns an
 * object that quacks like the Anthropic SDK (beta.messages.create), same as the
 * OpenAI-compatible adapter.
 */
export function createVertexGeminiClient(
  provider: Pick<RayuProvider, 'id' | 'gcpProject' | 'gcpRegion'>,
  maxRetries: number,
): unknown {
  const project = provider.gcpProject ?? ''
  const region = provider.gcpRegion || DEFAULT_VERTEX_REGION
  const baseURL = vertexBaseURL(project, region)
  return createOpenAICompatibleClient({
    apiKey: '',
    baseURL,
    maxRetries,
    providerId: provider.id,
    fetch: buildVertexFetch(),
  })
}
