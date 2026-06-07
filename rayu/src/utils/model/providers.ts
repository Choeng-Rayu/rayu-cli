import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { isEnvTruthy } from '../envUtils.js'

export type APIProvider = 'anthropic' | 'bedrock' | 'vertex' | 'foundry'

export function getAPIProvider(): APIProvider {
  // Env vars take absolute precedence (existing behavior).
  if (isEnvTruthy(process.env.RAYU_USE_BEDROCK)) return 'bedrock'
  if (isEnvTruthy(process.env.RAYU_USE_VERTEX)) return 'vertex'
  if (isEnvTruthy(process.env.RAYU_USE_FOUNDRY)) return 'foundry'

  // Rayu config: if the active provider is kind:'bedrock', route to bedrock.
  // This allows /connect → AWS Bedrock to work without env vars.
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { getActiveProvider } =
      require('../rayuConfig.js') as typeof import('../rayuConfig.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (getActiveProvider()?.kind === 'bedrock') return 'bedrock'
  } catch {
    // fall through
  }

  return 'anthropic'
}

/**
 * Rayu: true when the active Rayu provider is NOT anthropic (i.e. openai-compatible
 * or any other non-Anthropic kind). Use this to gate Anthropic-specific network
 * calls (policy limits, remote settings) that must be skipped for third-party providers.
 */
export function isRayuNonAnthropicActive(): boolean {
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { getActiveProvider } =
      require('../rayuConfig.js') as typeof import('../rayuConfig.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    const kind = getActiveProvider()?.kind
    return !!kind && kind !== 'anthropic'
  } catch {
    return false
  }
}

/**
 * Rayu: true when the active provider is an OpenAI-compatible endpoint
 * (OpenAI / NVIDIA / OpenRouter / local). Kept separate from the APIProvider
 * union so the Record<APIProvider, ModelName> model-config contract is
 * unaffected; the client routes to the OpenAI adapter when this is true.
 * Env override RAYU_OPENAI_COMPATIBLE=1 forces it on (useful for tests/CI).
 */
export function isOpenAICompatibleActive(): boolean {
  if (isEnvTruthy(process.env.RAYU_OPENAI_COMPATIBLE)) {
    return true
  }
  // Anthropic 3P env providers take precedence; only consult Rayu config when
  // none of them are set.
  if (
    isEnvTruthy(process.env.RAYU_USE_BEDROCK) ||
    isEnvTruthy(process.env.RAYU_USE_VERTEX) ||
    isEnvTruthy(process.env.RAYU_USE_FOUNDRY)
  ) {
    return false
  }
  try {
    // Lazy require to avoid a static import cycle (providers.ts is a leaf).
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { getActiveProvider } =
      require('../rayuConfig.js') as typeof import('../rayuConfig.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    const p = getActiveProvider()
    if (p?.kind === 'openai-compatible') return true
    // Rayu /connect → AWS Bedrock uses the OpenAI-compatible Chat Completions
    // endpoint (https://bedrock-runtime.{region}.amazonaws.com/openai/v1) with a
    // Bedrock API key (bearer token). Route it through the same adapter — but
    // NOT the Anthropic-Messages Bedrock variant (bedrockApi:'anthropic'), which
    // goes through the AnthropicBedrock SDK instead.
    if (
      p?.kind === 'bedrock' &&
      p.bedrockApi !== 'anthropic' &&
      !!p.apiKey &&
      !!p.baseURL
    ) {
      return true
    }
    return false
  } catch {
    return false
  }
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Rayu: true when the active provider is the Gemini-on-Vertex provider
 * (kind:'vertex'). Routed to a dedicated OpenAI-adapter client that injects a
 * Google Cloud OAuth bearer token and the `google/` model prefix.
 */
export function isVertexGeminiActive(): boolean {
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { getActiveProvider } =
      require('../rayuConfig.js') as typeof import('../rayuConfig.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    return getActiveProvider()?.kind === 'vertex'
  } catch {
    return false
  }
}

/**
 * Rayu: synchronous best-effort check that Gemini-on-Vertex credentials are
 * usable for image/video generation, without awaiting an ADC probe. True when
 * a kind:'vertex' provider is configured, or GCP ADC env hints are present.
 * Used to gate the Imagen/Veo tools and route them to Vertex.
 */
export function isGeminiVertexConfigured(): boolean {
  if (
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.ANTHROPIC_VERTEX_PROJECT_ID
  ) {
    return true
  }
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { loadRayuConfig } =
      require('../rayuConfig.js') as typeof import('../rayuConfig.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    return loadRayuConfig().providers.some(p => p.kind === 'vertex')
  } catch {
    return false
  }
}

/**
 * Check if ANTHROPIC_BASE_URL is a first-party Anthropic API URL.
 * Returns true if not set (default API) or points to api.anthropic.com
 * (or api-staging.anthropic.com for ant users).
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    if (process.env.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}
