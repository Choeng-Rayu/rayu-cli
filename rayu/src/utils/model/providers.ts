import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { isEnvTruthy } from '../envUtils.js'

export type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry'

export function getAPIProvider(): APIProvider {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)
    ? 'bedrock'
    : isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)
      ? 'vertex'
      : isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
        ? 'foundry'
        : 'firstParty'
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
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
  ) {
    return false
  }
  try {
    // Lazy require to avoid a static import cycle (providers.ts is a leaf).
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { getActiveProvider } =
      require('../rayuConfig.js') as typeof import('../rayuConfig.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    return getActiveProvider()?.kind === 'openai-compatible'
  } catch {
    return false
  }
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
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
