// Claude and the MaaS (model-as-a-service) models on Google Vertex AI.
//
// One Vertex provider serves THREE wire formats, chosen per model by
// resolveWireFormat():
//   Gemini → GenAI          …/publishers/google/models/{m}:streamGenerateContent
//                           (gemini/vertexGenaiClient.ts — unchanged)
//   Claude → Anthropic Msgs …/publishers/anthropic/models/{m}:streamRawPredict
//   MaaS   → OpenAI Chat    …/endpoints/openapi/chat/completions
//
// GROUNDING for the Claude path (read, not assumed): the OFFICIAL
// @anthropic-ai/vertex-sdk in node_modules. Its client (src/client.ts) shows:
//   • baseURL `https://{region}-aiplatform.googleapis.com/v1`, with the special
//     cases region 'global' → `https://aiplatform.googleapis.com/v1`,
//     'us'/'eu' → `https://aiplatform.{us,eu}.rep.googleapis.com/v1` (:90-101)
//   • the request rewrite (:163-181): `anthropic_version` is set to
//     'vertex-2023-10-16' (:12), `model` is REMOVED from the body, and the path
//     becomes
//     `/projects/{project}/locations/{region}/publishers/anthropic/models/{model}:{rawPredict|streamRawPredict}`
//     selected by `body.stream`
//   • it extends BaseAnthropic with NO custom stream decoder, so
//     streamRawPredict returns standard Anthropic SSE — unlike Bedrock, which
//     returns AWS binary event-stream and needs transcoding.
// We do not depend on that package (it is in neither package.json nor bun.lock);
// we reuse the shared Anthropic-Messages builder, which is what it does too.
//
// SECURITY: the Google OAuth bearer is minted per request and sent only to the
// Vertex host for the configured region; the rewritten URL's host is validated
// before the request goes out. Tokens are never logged.

/** Anthropic API version Vertex requires in the request body. */
export const VERTEX_ANTHROPIC_VERSION = 'vertex-2023-10-16'

/**
 * Vertex AI host for a location, matching the official SDK's mapping.
 * Kept here (rather than reusing rayuProviders.vertexHost) because the SDK also
 * recognizes the multi-region 'us'/'eu' locations, which the Gemini path does not
 * offer and whose hosts differ in shape.
 */
export function vertexAnthropicHost(region: string): string {
  const r = (region || 'global').trim()
  if (r === 'global') return 'aiplatform.googleapis.com'
  if (r === 'us') return 'aiplatform.us.rep.googleapis.com'
  if (r === 'eu') return 'aiplatform.eu.rep.googleapis.com'
  return `${r}-aiplatform.googleapis.com`
}

/** Base URL the Anthropic SDK is pointed at (it appends /v1/messages). */
export function vertexAnthropicBaseURL(region: string): string {
  return `https://${vertexAnthropicHost(region)}/v1`
}

/** The publisher path Vertex serves Claude on. */
export function vertexAnthropicPath(
  project: string,
  region: string,
  model: string,
  stream: boolean,
): string {
  const specifier = stream ? 'streamRawPredict' : 'rawPredict'
  return `/v1/projects/${project}/locations/${region || 'global'}/publishers/anthropic/models/${model}:${specifier}`
}

/**
 * Translate an Anthropic Messages request body into Vertex's rawPredict body:
 * drop `model` (it lives in the path) and add `anthropic_version`.
 */
export function toVertexRequestBody(body: string): {
  body: string
  model: string
  stream: boolean
} {
  const parsed = JSON.parse(body) as Record<string, unknown>
  const model = typeof parsed.model === 'string' ? parsed.model : ''
  const stream = parsed.stream === true
  delete parsed.model
  // `stream` selects the path specifier; Vertex also accepts it in the body, and
  // the official SDK leaves it there, so it is preserved.
  parsed.anthropic_version = VERTEX_ANTHROPIC_VERSION
  return { body: JSON.stringify(parsed), model, stream }
}

/**
 * Build the fetch that turns an Anthropic-SDK request into a Vertex
 * publisher-model rawPredict request.
 *
 * Unlike the Bedrock equivalent no response transcoding is needed: Vertex returns
 * native Anthropic JSON / SSE.
 */
export function makeVertexAnthropicFetch(opts: {
  project: string
  region: string
  /** Mints a Google OAuth access token (defaults to the shared resolver). */
  getToken: () => Promise<string>
  /** Inner fetch (the shared transport's logging/proxy fetch, or the gateway). */
  inner?: typeof fetch
}): typeof fetch {
  const region = opts.region || 'global'
  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1] = {},
  ): Promise<Response> => {
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const inner = opts.inner ?? globalThis.fetch
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const originalUrl = input instanceof Request ? input.url : String(input)
    const rawBody = init?.body
    if (typeof rawBody !== 'string' || !/\/v1\/messages\b/.test(originalUrl)) {
      // Not a Messages call — pass through untouched.
      return inner(input, init)
    }
    if (!opts.project) {
      throw new Error(
        'No GCP project configured for Vertex AI. Run /connect → Google Gemini — ' +
          'Vertex AI, or set GOOGLE_CLOUD_PROJECT.',
      )
    }

    const { body, model, stream } = toVertexRequestBody(rawBody)
    if (!model) {
      throw new Error(
        'Vertex request is missing a model id; cannot build the publisher path.',
      )
    }
    const origin = new URL(originalUrl).origin
    const expectedHost = vertexAnthropicHost(region)
    if (new URL(origin).host !== expectedHost) {
      // SECURITY: never send the Google OAuth token to an unexpected host.
      throw new Error(
        `Refusing to send Vertex credentials to unexpected host ${new URL(origin).host}`,
      )
    }
    const url = `${origin}${vertexAnthropicPath(opts.project, region, model, stream)}`

    const token = await opts.getToken()
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${token}`)
    headers.set('content-type', 'application/json')
    // Publisher endpoints bill against a quota project.
    headers.set('x-goog-user-project', opts.project)
    // Anthropic-specific headers Vertex does not accept.
    headers.delete('x-api-key')
    headers.delete('anthropic-version')

    return inner(url, {
      ...init,
      method: 'POST',
      body,
      headers,
      // The rewritten URL is absolute; never follow a redirect to another host.
      redirect: 'error',
    })
  }
  return wrapped as typeof fetch
}

/**
 * Claude models served by Vertex AI's `anthropic` publisher.
 *
 * Vertex has no reliable publisher-wide listing for third-party publishers (the
 * `publishers/google/models` catalog the Gemini path uses covers Google's own
 * models only), so this is a curated set — the same approach
 * CURATED_PROVIDER_MODELS takes for OpenAI-compatible providers whose /models
 * endpoint is unusable. Override with VERTEX_CLAUDE_MODELS (comma-separated).
 *
 * Vertex Claude ids use an `@`-dated suffix rather than the first-party date
 * suffix (e.g. `claude-sonnet-4-5@20250929`), which is why they cannot be reused
 * from configs.ts verbatim.
 */
export const KNOWN_VERTEX_CLAUDE_MODELS: string[] = [
  'claude-sonnet-4-5@20250929',
  'claude-opus-4-1@20250805',
  'claude-opus-4@20250514',
  'claude-sonnet-4@20250514',
  'claude-haiku-4-5@20251001',
  'claude-3-7-sonnet@20250219',
  'claude-3-5-haiku@20241022',
]

/**
 * MaaS models served through Vertex's OpenAI-compatible endpoint. Also curated,
 * for the same reason. Override with VERTEX_MAAS_MODELS.
 */
export const KNOWN_VERTEX_MAAS_MODELS: string[] = [
  'meta/llama-3.3-70b-instruct-maas',
  'meta/llama-4-scout-17b-16e-instruct-maas',
  'meta/llama-4-maverick-17b-128e-instruct-maas',
  'mistralai/mistral-large-2411',
  'mistralai/codestral-2501',
  'qwen/qwen3-next-80b-a3b-instruct-maas',
]

function fromEnvList(name: string, fallback: string[]): string[] {
  const raw = process.env[name]
  if (raw && raw.trim()) {
    return raw
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  }
  return fallback
}

/** Curated Claude ids for Vertex (env-overridable). */
export function curatedVertexClaudeModels(): string[] {
  return fromEnvList('VERTEX_CLAUDE_MODELS', KNOWN_VERTEX_CLAUDE_MODELS)
}

/** Curated MaaS ids for Vertex (env-overridable). */
export function curatedVertexMaasModels(): string[] {
  return fromEnvList('VERTEX_MAAS_MODELS', KNOWN_VERTEX_MAAS_MODELS)
}

/** True when a Vertex model id denotes an OpenAI-compatible MaaS model. */
export function isVertexMaasModelId(model: string): boolean {
  // MaaS ids carry a publisher prefix (`meta/`, `mistralai/`, `qwen/`, …) and/or
  // the `-maas` suffix. Gemini and Claude ids never do.
  return /-maas$/i.test(model) || /^(meta|mistralai|qwen|deepseek-ai|ai21)\//i.test(model)
}
