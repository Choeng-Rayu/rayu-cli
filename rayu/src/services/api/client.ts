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
 * Environment variables for different client types:
 *
 * Direct API:
 * - ANTHROPIC_API_KEY: Required for direct API access
 *
 * AWS Bedrock:
 * - AWS credentials configured via aws-sdk defaults
 * - AWS_REGION or AWS_DEFAULT_REGION: Sets the AWS region for all models (default: us-east-1)
 * - ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION: Optional. Override AWS region specifically for the small fast model (Haiku)
 *
 * Foundry (Azure):
 * - ANTHROPIC_FOUNDRY_RESOURCE: Your Azure resource name (e.g. 'my-resource')
 *   For the full endpoint: https://{resource}.services.ai.azure.com/anthropic/v1/messages
 * - ANTHROPIC_FOUNDRY_BASE_URL: Optional. Alternative to resource - provide full base URL directly
 *   (e.g. 'https://my-resource.services.ai.azure.com')
 *
 * Authentication (one of the following):
 * - ANTHROPIC_FOUNDRY_API_KEY: Your Microsoft Foundry API key (if using API key auth)
 * - Azure AD authentication: If no API key is provided, uses DefaultAzureCredential
 *   which supports multiple auth methods (environment variables, managed identity,
 *   Azure CLI, etc.). See: https://docs.microsoft.com/en-us/javascript/api/@azure/identity
 *
 * Vertex AI:
 * - Model-specific region variables (highest priority):
 *   - VERTEX_REGION_CLAUDE_3_5_HAIKU: Region for Claude 3.5 Haiku model
 *   - VERTEX_REGION_CLAUDE_HAIKU_4_5: Region for Claude Haiku 4.5 model
 *   - VERTEX_REGION_CLAUDE_3_5_SONNET: Region for Claude 3.5 Sonnet model
 *   - VERTEX_REGION_CLAUDE_3_7_SONNET: Region for Claude 3.7 Sonnet model
 * - CLOUD_ML_REGION: Optional. The default GCP region to use for all models
 *   If specific model region not specified above
 * - ANTHROPIC_VERTEX_PROJECT_ID: Required. Your GCP project ID
 * - Standard GCP credentials configured via google-auth-library
 *
 * Priority for determining region:
 * 1. Hardcoded model-specific environment variables
 * 2. Global CLOUD_ML_REGION variable
 * 3. Default region from config
 * 4. Fallback region (us-east5)
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
