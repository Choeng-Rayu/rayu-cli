import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk/index.js'
import { randomUUID } from 'crypto'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getAnthropicApiKey,
} from 'src/utils/auth.js'
import { getUserAgent } from 'src/utils/http.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
  isOpenAICompatibleActive,
} from 'src/utils/model/providers.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'
import {
  getIsNonInteractiveSession,
  getSessionId,
} from '../../bootstrap/state.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { isDebugToStdErr, logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

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
 * - ANTHROPIC_FOUNDRY_RESOURCE: Your Azure resource name (e.g., 'my-resource')
 *   For the full endpoint: https://{resource}.services.ai.azure.com/anthropic/v1/messages
 * - ANTHROPIC_FOUNDRY_BASE_URL: Optional. Alternative to resource - provide full base URL directly
 *   (e.g., 'https://my-resource.services.ai.azure.com')
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

function createStderrLogger(): ClientOptions['logger'] {
  return {
    error: (msg, ...args) =>
      // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
      console.error('[Anthropic SDK ERROR]', msg, ...args),
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    warn: (msg, ...args) => console.error('[Anthropic SDK WARN]', msg, ...args),
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    info: (msg, ...args) => console.error('[Anthropic SDK INFO]', msg, ...args),
    debug: (msg, ...args) =>
      // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
      console.error('[Anthropic SDK DEBUG]', msg, ...args),
  }
}

/**
 * Rayu: build an OpenAI-compatible adapter client from the active provider's
 * config (api key + base URL). Env overrides RAYU_OPENAI_BASE_URL /
 * RAYU_OPENAI_API_KEY take precedence (useful for CI/tests). Returns null when
 * no base URL can be resolved, so the caller falls back to the Anthropic path.
 *
 * Provider changes update the in-memory config cache through saveRayuConfig(),
 * so this hot path can reuse that cache instead of hitting disk every request.
 */
async function getRayuOpenAICompatibleClient(
  maxRetries: number,
): Promise<unknown | null> {
  const { getActiveProvider } = await import('src/utils/rayuConfig.js')
  const { createOpenAICompatibleClient } = await import('./openaiAdapter.js')
  const active = getActiveProvider()
  const baseURL =
    process.env.RAYU_OPENAI_BASE_URL ?? active?.baseURL ?? ''
  const apiKey =
    process.env.RAYU_OPENAI_API_KEY ?? active?.apiKey ?? ''
  if (!baseURL) {
    return null
  }
  return createOpenAICompatibleClient({
    apiKey,
    baseURL,
    maxRetries,
    providerId: active?.id,
    promptCacheKey: active?.promptCacheKey,
    reasoningEffort: active?.reasoningEffort,
    streamOptions: active?.streamOptions,
  })
}

/**
 * Rayu: build an AnthropicBedrock client (@anthropic-ai/bedrock-sdk) for the
 * active provider when it is a Bedrock provider configured for the Anthropic
 * Messages API (bedrockApi:'anthropic'). Authenticates with the Bedrock API key
 * (bearer token) — no AWS SigV4 credentials required — and presents the same
 * beta.messages.create surface (incl. streaming + tool use) that claude.ts uses.
 * Returns null when the active provider is not an Anthropic-style Bedrock
 * provider, so the caller falls through to the other client paths.
 * SECURITY: the bearer token is read from the 0600 provider config; never logged.
 */
async function getRayuBedrockAnthropicClient(
  maxRetries: number,
): Promise<unknown | null> {
  const { getActiveProvider } = await import('src/utils/rayuConfig.js')
  const active = getActiveProvider()
  if (
    active?.kind !== 'bedrock' ||
    active.bedrockApi !== 'anthropic' ||
    !active.apiKey
  ) {
    return null
  }
  const { AnthropicBedrock } = await import('@anthropic-ai/bedrock-sdk')
  return new AnthropicBedrock({
    apiKey: active.apiKey,
    awsRegion: active.awsRegion || process.env.AWS_REGION || 'us-east-1',
    maxRetries,
  })
}

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
  // Rayu: route to the AnthropicBedrock SDK when the active provider is a
  // Bedrock provider configured for the Anthropic Messages API (Claude models).
  const bedrockAnthropicClient = await getRayuBedrockAnthropicClient(maxRetries)
  if (bedrockAnthropicClient) {
    return bedrockAnthropicClient as unknown as Anthropic
  }

  // Rayu: route to the OpenAI-compatible adapter when the active provider is an
  // OpenAI-compatible endpoint (OpenAI/NVIDIA/OpenRouter/local). The adapter
  // presents the same beta.messages.create surface claude.ts depends on.
  if (isOpenAICompatibleActive()) {
    const rayuClient = await getRayuOpenAICompatibleClient(maxRetries)
    if (rayuClient) {
      return rayuClient as unknown as Anthropic
    }
  }

  const containerId = process.env.CLAUDE_CODE_CONTAINER_ID
  const remoteSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
  const customHeaders = getCustomHeaders()
  const defaultHeaders: { [key: string]: string } = {
    'x-app': 'cli',
    'User-Agent': getUserAgent(),
    'X-Claude-Code-Session-Id': getSessionId(),
    ...customHeaders,
    ...(containerId ? { 'x-claude-remote-container-id': containerId } : {}),
    ...(remoteSessionId
      ? { 'x-claude-remote-session-id': remoteSessionId }
      : {}),
    // SDK consumers can identify their app/library for backend analytics
    ...(clientApp ? { 'x-client-app': clientApp } : {}),
  }

  // Log API client configuration for HFI debugging
  logForDebugging(
    `[API:request] Creating client, ANTHROPIC_CUSTOM_HEADERS present: ${!!process.env.ANTHROPIC_CUSTOM_HEADERS}, has Authorization header: ${!!customHeaders['Authorization']}`,
  )

  // Add additional protection header if enabled via env var
  const additionalProtectionEnabled = isEnvTruthy(
    process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION,
  )
  if (additionalProtectionEnabled) {
    defaultHeaders['x-anthropic-additional-protection'] = 'true'
  }

  // Rayu connects only to first-party Anthropic-shaped endpoints and
  // OpenAI-compatible providers. The OpenAI-compatible path already returned
  // above; here we configure standard Anthropic auth headers.
  logForDebugging('[API:auth] OAuth token check starting')
  await checkAndRefreshOAuthTokenIfNeeded()
  logForDebugging('[API:auth] OAuth token check complete')

  await configureApiKeyHeaders(defaultHeaders, getIsNonInteractiveSession())

  const resolvedFetch = buildFetch(fetchOverride, source)

  const ARGS = {
    defaultHeaders,
    maxRetries,
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    dangerouslyAllowBrowser: true,
    fetchOptions: getProxyFetchOptions({
      forAnthropicAPI: true,
    }) as ClientOptions['fetchOptions'],
    ...(resolvedFetch && {
      fetch: resolvedFetch,
    }),
  }

  const clientConfig: ConstructorParameters<typeof Anthropic>[0] = {
    apiKey: apiKey || getAnthropicApiKey() || undefined,
    // Set baseURL from OAuth config when using staging OAuth
    ...(process.env.USER_TYPE === 'ant' &&
    isEnvTruthy(process.env.USE_STAGING_OAUTH)
      ? { baseURL: getOauthConfig().BASE_API_URL }
      : {}),
    ...ARGS,
    ...(isDebugToStdErr() && { logger: createStderrLogger() }),
  }

  return new Anthropic(clientConfig)
}

async function configureApiKeyHeaders(
  headers: Record<string, string>,
  isNonInteractiveSession: boolean,
): Promise<void> {
  void isNonInteractiveSession
  const token = process.env.RAYU_ANTHROPIC_AUTH_TOKEN
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
}

function getCustomHeaders(): Record<string, string> {
  const customHeaders: Record<string, string> = {}
  const customHeadersEnv = process.env.ANTHROPIC_CUSTOM_HEADERS

  if (!customHeadersEnv) return customHeaders

  // Split by newlines to support multiple headers
  const headerStrings = customHeadersEnv.split(/\n|\r\n/)

  for (const headerString of headerStrings) {
    if (!headerString.trim()) continue

    // Parse header in format "Name: Value" (curl style). Split on first `:`
    // then trim — avoids regex backtracking on malformed long header lines.
    const colonIdx = headerString.indexOf(':')
    if (colonIdx === -1) continue
    const name = headerString.slice(0, colonIdx).trim()
    const value = headerString.slice(colonIdx + 1).trim()
    if (name) {
      customHeaders[name] = value
    }
  }

  return customHeaders
}

export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'

function buildFetch(
  fetchOverride: ClientOptions['fetch'],
  source: string | undefined,
): ClientOptions['fetch'] {
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  const inner = fetchOverride ?? globalThis.fetch
  // Only send to the first-party API — Bedrock/Vertex/Foundry don't log it
  // and unknown headers risk rejection by strict proxies (inc-4029 class).
  const injectClientRequestId =
    getAPIProvider() === 'anthropic' &&
    !isOpenAICompatibleActive() &&
    isFirstPartyAnthropicBaseUrl()
  return (input, init) => {
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers(init?.headers)
    // Generate a client-side request ID so timeouts (which return no server
    // request ID) can still be correlated with server logs by the API team.
    // Callers that want to track the ID themselves can pre-set the header.
    if (injectClientRequestId && !headers.has(CLIENT_REQUEST_ID_HEADER)) {
      headers.set(CLIENT_REQUEST_ID_HEADER, randomUUID())
    }
    try {
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const url = input instanceof Request ? input.url : String(input)
      const id = headers.get(CLIENT_REQUEST_ID_HEADER)
      logForDebugging(
        `[API REQUEST] ${new URL(url).pathname}${id ? ` ${CLIENT_REQUEST_ID_HEADER}=${id}` : ''} source=${source ?? 'unknown'}`,
      )
    } catch {
      // never let logging crash the fetch
    }
    return inner(input, { ...init, headers })
  }
}
