import type Anthropic from '@anthropic-ai/sdk/index.js'
import type { ClientOptions } from '@anthropic-ai/sdk/index.js'
import { isOpenAICompatibleActive } from 'src/utils/model/providers.js'
import { CLIENT_REQUEST_ID_HEADER } from './anthropicTransport.js'
import {
  buildClient,
  buildEnvOpenAIChatClient,
  buildFirstPartyAnthropicClient,
} from './providerRegistry.js'

// Re-exported so existing importers (claude.ts) keep their import path while the
// implementation lives in the shared Anthropic transport module.
export { CLIENT_REQUEST_ID_HEADER }

/**
 * Environment variables read by the provider layer.
 *
 * Every provider is now built by services/api/providerRegistry.ts, which resolves
 * a WIRE FORMAT per (provider, model) and then an auth strategy. This comment
 * documents only the env-var entry points; the authoritative map of
 * kind → format → auth is the table in AGENTS.md and the docs in each module.
 *
 * First-party Anthropic:
 * - ANTHROPIC_API_KEY: direct API access
 * - ANTHROPIC_BASE_URL: proxy override (a provider behind a proxy is NOT treated
 *   as first-party — see utils/model/providerCapabilities.isFirstPartyRequest)
 * - ANTHROPIC_CUSTOM_HEADERS: extra headers, FIRST-PARTY ONLY (they may carry an
 *   Authorization credential; see anthropicTransport.ts)
 *
 * AWS Bedrock (ONE provider, format per model: Claude → Anthropic Messages,
 * everything else → OpenAI Chat on bedrock-mantle):
 * - AWS_BEARER_TOKEN_BEDROCK: Bedrock API key
 * - AWS_REGION / AWS_DEFAULT_REGION: region (default us-east-1)
 * - ANTHROPIC_BEDROCK_BASE_URL: endpoint override
 *
 * Microsoft Azure / Foundry (ONE provider, format per model: Claude → Anthropic
 * Messages at {resource}/anthropic, everything else → Azure OpenAI Responses at
 * {resource}/openai/v1) — see services/api/azureFoundry.ts:
 * - ANTHROPIC_FOUNDRY_API_KEY / AZURE_OPENAI_API_KEY: resource API key
 * - ANTHROPIC_FOUNDRY_RESOURCE: resource name, or
 * - ANTHROPIC_FOUNDRY_BASE_URL: full endpoint URL
 * - Entra ID / DefaultAzureCredential auth is NOT implemented (API key only).
 *
 * Google Vertex AI (ONE provider, THREE formats per model: Gemini → GenAI,
 * Claude → Anthropic Messages, MaaS → OpenAI Chat):
 * - ANTHROPIC_VERTEX_PROJECT_ID / GOOGLE_CLOUD_PROJECT: GCP project
 * - CLOUD_ML_REGION: region ('global' serves the newest Gemini models)
 * - Standard GCP credentials via google-auth-library (ADC / interactive OAuth)
 * - VERTEX_GEMINI_MODELS / VERTEX_CLAUDE_MODELS / VERTEX_MAAS_MODELS: override the
 *   curated model sets (Vertex has no publisher-wide listing for third-party
 *   publishers)
 *
 * OpenAI-compatible (headless/CI escape hatch, no saved provider needed):
 * - RAYU_OPENAI_COMPATIBLE=1, RAYU_OPENAI_BASE_URL, RAYU_OPENAI_API_KEY
 *   (these override the ACTIVE provider only — never a routed subagent's)
 */

/**
 * Resolve the provider a request should be served by.
 *
 * Rayu multi-provider routing: the request "model" may carry a provider prefix
 * (`providerId\u0000model`) so a subagent / swarm collaborator can run on a
 * DIFFERENT provider than the active one, concurrently. When present, that
 * provider wins. The request body's model is independently stripped to the bare
 * id by normalizeModelStringForAPI, so the wire model is always clean regardless
 * of routing. This avoids AsyncLocalStorage, which is unreliable across async
 * generators on Bun.
 */
async function resolveRequestProvider(
  model: string | undefined,
): Promise<import('src/utils/rayuConfig.js').RayuProvider | undefined> {
  const { decodeModelProvider, getActiveProvider, loadRayuConfig } =
    await import('src/utils/rayuConfig.js')
  if (model) {
    const { providerId } = decodeModelProvider(model)
    if (providerId) {
      const routed = loadRayuConfig().providers.find(p => p.id === providerId)
      if (routed) return routed
    }
  }
  return getActiveProvider()
}

/**
 * Exposed for tests: the provider-resolution decision (routed provider from the
 * encoded model, else the active provider) is the half of routing that used to
 * be duplicated, so it is asserted directly rather than inferred from a
 * constructed client.
 */
export const _resolveRequestProviderForTesting = resolveRequestProvider

/**
 * Build the API client for a request.
 *
 * Every provider goes through ONE dispatch table (providerRegistry.buildClient),
 * for the main agent and for any subagent / swarm collaborator routed to a
 * different provider. First-party Anthropic is the terminal fallback, which also
 * covers "no provider configured yet" (fresh install, SDK consumers, tests).
 */
export async function getAnthropicClient({
  apiKey,
  maxRetries,
  model,
  fetchOverride,
  source,
}: {
  apiKey?: string
  maxRetries: number
  model?: string
  fetchOverride?: ClientOptions['fetch']
  source?: string
}): Promise<Anthropic> {
  const provider = await resolveRequestProvider(model)
  if (provider) {
    const client = await buildClient(provider, {
      maxRetries,
      model,
      source,
      fetchOverride,
      // RAYU_OPENAI_BASE_URL / RAYU_OPENAI_API_KEY may override only the ACTIVE
      // provider's endpoint+key (CI/headless escape hatch); a request explicitly
      // routed to another provider must keep that provider's own credentials.
      allowEnvOverrides: !isRoutedModel(model),
    })
    if (client) {
      return client as unknown as Anthropic
    }
  }

  // Env-only OpenAI-compatible escape hatch: RAYU_OPENAI_COMPATIBLE=1 +
  // RAYU_OPENAI_BASE_URL with no saved provider (or with a first-party Anthropic
  // provider saved), used for headless/CI runs.
  if (isOpenAICompatibleActive()) {
    const envClient = await buildEnvOpenAIChatClient(provider, maxRetries)
    if (envClient) {
      return envClient as unknown as Anthropic
    }
  }

  return buildFirstPartyAnthropicClient({
    maxRetries,
    apiKey,
    source,
    fetchOverride,
    provider,
  })
}

/** True when the model string carries a `providerId\u0000` routing prefix. */
function isRoutedModel(model: string | undefined): boolean {
  return !!model && model.includes('\u0000')
}
