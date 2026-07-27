// Provider registry — the SINGLE dispatch table from a Rayu provider to an API
// client.
//
// WHY THIS EXISTS
// Before this module, client.ts carried TWO parallel dispatch tables with
// byte-identical bodies:
//   • nine `getRayuXClient(maxRetries)` wrappers, each re-reading
//     getActiveProvider() and handling one kind, used for the MAIN agent; and
//   • `buildClientForProvider(provider, maxRetries)`, the same nine branches
//     again, used when a subagent / swarm collaborator is routed to a DIFFERENT
//     provider than the active one (model string encoded as
//     `providerId\u0000model` — see rayuConfig.encodeModelWithProvider).
// Registering a provider in only one of them silently broke the other half of
// the product. Everything now goes through `buildClient`, which takes the
// provider explicitly, so the main agent and every routed agent share one path.
//
// WIRE FORMAT vs PROVIDER KIND
// The 9 ProviderKind values collapse onto a much smaller set of actual wire
// protocols. `resolveWireFormat` is the single place that mapping lives.
// Anthropic Messages is not merely one of the formats — it is the app's internal
// IR: claude.ts builds an Anthropic Messages (beta) request and every adapter
// presents `beta.messages.create(...).withResponse()`, translating outward from
// that shape.
//
// SECURITY: every branch pins its credentials to that provider's own host. A
// provider's key/token is read from the 0600 provider config, sent only to that
// provider's endpoint, and never logged. Key lists are resolved exclusively via
// providerKeys.resolveProviderApiKeys so the paid multi-key gate cannot be
// bypassed by a branch that forgot to apply it.
import type { ClientOptions } from '@anthropic-ai/sdk/index.js'
import type Anthropic from '@anthropic-ai/sdk/index.js'
import { extractModelIdFromArn } from '../../utils/model/bedrock.js'
import { normalizeModelStringForAPI } from '../../utils/model/model.js'
import type { RayuProvider, WireFormat } from '../../utils/rayuConfig.js'
import { anthropicTransportOptions } from './anthropicTransport.js'
import { createAnthropicMessagesClient } from './anthropicMessagesClient.js'
import { resolveProviderApiKeys } from './providerKeys.js'

export type { WireFormat }

/**
 * True when a Bedrock/Vertex/Azure model id denotes an Anthropic Claude model.
 *
 * Real ids this must match (verified against the catalog fetchers in
 * rayuConfig.ts and the fixtures in test/bedrockCapabilities.test.ts):
 *   anthropic.claude-3-5-sonnet-20241022-v2:0          (bare foundation model)
 *   us.anthropic.claude-sonnet-4-6-v1                   (cross-region profile)
 *   global.anthropic.claude-haiku-4-5-20251001-v1:0
 *   arn:aws:bedrock:…:inference-profile/global.anthropic.claude-opus-4-6-v1
 *   claude-sonnet-4-5@20250929                          (Vertex publisher form)
 */
function isClaudeModelId(model: string): boolean {
  return /(^|[.\-/])anthropic[.\-/]|claude/i.test(model)
}

/** True when a model id denotes a Google Gemini model. */
function isGeminiModelId(model: string): boolean {
  return /gemini/i.test(model)
}

/**
 * Strip the routing prefix and context-window suffix from a request model so
 * pattern rules see the bare provider-native id.
 *
 * `normalizeModelStringForAPI` is the same function claude.ts uses to build the
 * wire model (`providerId\u0000model` prefix + `[1m]`/`[2m]` suffixes removed),
 * reused here rather than re-implemented so the two can never disagree about
 * what the model actually is. Bedrock ids may additionally arrive as ARNs.
 */
function bareModelId(model: string | undefined): string {
  if (!model) return ''
  return extractModelIdFromArn(normalizeModelStringForAPI(model))
}

/**
 * The wire protocols Rayu actually speaks.
 *
 * - `anthropic-messages` — the native Anthropic Messages API and every
 *   third-party endpoint that serves it verbatim (first-party Anthropic,
 *   anthropic-compatible BYO-key endpoints, rayu-hosted, Anthropic-style
 *   Bedrock). No translation: this is the internal IR.
 * - `openai-chat` — OpenAI `/chat/completions` (OpenAI, NVIDIA, OpenRouter,
 *   local servers, GitHub Copilot, Bedrock's OpenAI-compatible surface).
 * - `openai-responses` — OpenAI `/responses` (added in Task 7).
 * - `genai` — Google Gemini (Vertex AI native genai + Login-with-Gemini Code
 *   Assist).
 * - `codewhisperer` — Kiro's AWS CodeWhisperer event-stream protocol. Unique to
 *   one provider.
 * - `bedrock-converse` — AWS Converse/ConverseStream. Retired in Task 6 of this
 *   migration; still listed so the registry can describe today's providers.
 *
 * The type itself is declared in rayuConfig.ts (next to ProviderKind) so config
 * types carry no dependency on the request layer; it is re-exported above for
 * callers that already import from this module.
 */

/**
 * Resolve the wire format for a (provider, model) pair.
 *
 * Precedence:
 *   1. `provider.wireFormat` — an explicit override (custom providers, where the
 *      user picks the format in /connect).
 *   2. `provider.bedrockApi` — the LEGACY Bedrock surface discriminator. Honored
 *      so providers already saved in ~/.rayu keep working; removed in Task 5 of
 *      this migration, after which Bedrock is purely per-model.
 *   3. per-kind model-pattern rules — this is what lets ONE provider entry serve
 *      several formats (Bedrock: Claude → Anthropic Messages, everything else →
 *      OpenAI Chat; Vertex: Gemini → GenAI).
 *   4. the kind's default format.
 *
 * Pure: no I/O, no config reads, so the full table is directly assertable.
 */
export function resolveWireFormat(
  provider: RayuProvider,
  model?: string,
): WireFormat {
  // 1. Explicit override.
  if (provider.wireFormat) return provider.wireFormat

  const bare = bareModelId(model)

  switch (provider.kind) {
    case 'anthropic':
    case 'anthropic-compatible':
    case 'rayu-hosted':
      return 'anthropic-messages'

    case 'bedrock': {
      // ONE Bedrock provider, format chosen per MODEL. Claude is invocable only
      // through the Anthropic Messages surface on bedrock-runtime; everything
      // Bedrock exposes over OpenAI Chat Completions (gpt-oss, qwen, deepseek,
      // mistral, …) goes to the bedrock-mantle endpoint.
      //
      // The legacy `bedrockApi` discriminator is still honored for providers
      // saved by older versions that have not been migrated yet
      // (migrateBedrockToUnifiedProvider drops it at startup).
      if (provider.bedrockApi === 'anthropic') return 'anthropic-messages'
      if (provider.bedrockApi === 'converse') return 'bedrock-converse'
      if (provider.bedrockApi === 'openai') return 'openai-chat'
      if (bare && isClaudeModelId(bare)) return 'anthropic-messages'
      return 'openai-chat'
    }

    case 'vertex':
      // Gemini today. Claude-on-Vertex (Anthropic Messages via streamRawPredict)
      // and the MaaS models (Llama/Mistral/Qwen over OpenAI Chat) get their
      // per-model rules in Task 9, together with the clients that serve them —
      // adding the rule earlier would resolve a format with no implementation
      // behind it.
      return 'genai'

    case 'genai':
      return 'genai'

    case 'kiro':
      return 'codewhisperer'

    case 'copilot':
    case 'openai-compatible':
      return 'openai-chat'

    default:
      return 'openai-chat'
  }
}

/** Exposed for tests: the model-family predicates the per-model rules use. */
export const _modelFamilyForTesting = {
  isClaudeModelId,
  isGeminiModelId,
  bareModelId,
}

/**
 * The concrete client implementation a provider resolves to.
 *
 * Separating the DECISION (this function) from the CONSTRUCTION (`buildClient`)
 * is what makes the dispatch table verifiable: the decision is pure and can be
 * asserted for every (kind, model, config) combination without instantiating
 * SDKs or mocking modules.
 */
export type ClientTarget =
  | 'first-party-anthropic'
  | 'anthropic-compatible'
  | 'rayu-hosted'
  | 'bedrock-anthropic'
  | 'bedrock-converse'
  | 'openai-chat'
  | 'vertex-genai'
  | 'genai-code-assist'
  | 'kiro'
  | 'copilot'
  /** No usable client for this provider (missing credentials/endpoint). */
  | 'unsupported'

/**
 * Resolve which client implementation serves a provider.
 *
 * `first-party-anthropic` is returned for kind:'anthropic' but is NOT built by
 * this module — client.ts owns it because it carries OAuth refresh, the
 * apiKeyHelper chain and first-party-only headers.
 */
export function resolveClientTarget(
  provider: RayuProvider,
  model?: string,
  opts: { allowEnvOverrides?: boolean } = {},
): ClientTarget {
  const format = resolveWireFormat(provider, model)
  switch (provider.kind) {
    case 'anthropic':
      return 'first-party-anthropic'
    case 'anthropic-compatible':
      return 'anthropic-compatible'
    case 'rayu-hosted':
      return 'rayu-hosted'
    case 'vertex':
      return 'vertex-genai'
    case 'genai':
      return 'genai-code-assist'
    case 'kiro':
      return 'kiro'
    case 'copilot':
      return 'copilot'
    case 'bedrock': {
      if (format === 'anthropic-messages') {
        // Anthropic Messages on Bedrock is bearer-token (Bedrock API key) mode;
        // without a key there is nothing to authenticate with.
        return provider.apiKey ? 'bedrock-anthropic' : 'unsupported'
      }
      if (format === 'bedrock-converse') return 'bedrock-converse'
      // Bedrock's OpenAI-compatible Chat Completions surface (bedrock-mantle)
      // needs both a key and an endpoint, matching isOpenAICompatibleActive().
      return provider.apiKey && hasOpenAIChatEndpoint(provider, opts)
        ? 'openai-chat'
        : 'unsupported'
    }    case 'openai-compatible':
      return hasOpenAIChatEndpoint(provider, opts) ? 'openai-chat' : 'unsupported'
    default:
      return 'unsupported'
  }
}

function hasOpenAIChatEndpoint(
  provider: RayuProvider,
  opts: { allowEnvOverrides?: boolean },
): boolean {
  return !!resolveOpenAIChatBaseURL(provider, opts.allowEnvOverrides)
}

/**
 * The base URL an OpenAI-Chat provider will be called at.
 *
 * `allowEnvOverrides` reproduces the previous ACTIVE-provider behavior where
 * RAYU_OPENAI_BASE_URL wins (a CI/headless escape hatch). A request explicitly
 * routed to another provider must never be redirected to the env host.
 */
export function resolveOpenAIChatBaseURL(
  provider: RayuProvider | undefined,
  allowEnvOverrides?: boolean,
): string {
  return (
    (allowEnvOverrides ? process.env.RAYU_OPENAI_BASE_URL : undefined) ??
    provider?.baseURL ??
    ''
  )
}

/** Config passed to the OpenAI-Chat adapter. Pure, so it is directly assertable. */
export type OpenAIChatConfig = {
  apiKey: string
  apiKeys: string[]
  baseURL: string
  maxRetries: number
  providerId?: string
  promptCacheKey?: RayuProvider['promptCacheKey']
  reasoningEffort?: RayuProvider['reasoningEffort']
  streamOptions?: RayuProvider['streamOptions']
}

/**
 * Resolve the OpenAI-Chat adapter config for a provider: endpoint + the gated
 * key list. Returns null when no endpoint can be resolved, so the caller falls
 * through instead of building a client that would fail at request time.
 *
 * SECURITY: the key list comes from resolveProviderApiKeys (paid multi-key gate)
 * and is only ever paired with THIS provider's endpoint.
 */
export async function resolveOpenAIChatConfig(
  provider: RayuProvider | undefined,
  opts: { maxRetries: number; allowEnvOverrides?: boolean },
): Promise<OpenAIChatConfig | null> {
  const baseURL = resolveOpenAIChatBaseURL(provider, opts.allowEnvOverrides)
  if (!baseURL) return null
  const apiKeys = await resolveProviderApiKeys(
    provider,
    opts.allowEnvOverrides ? process.env.RAYU_OPENAI_API_KEY : undefined,
  )
  return {
    apiKey: apiKeys[0] ?? '',
    apiKeys,
    baseURL,
    maxRetries: opts.maxRetries,
    providerId: provider?.id,
    promptCacheKey: provider?.promptCacheKey,
    reasoningEffort: provider?.reasoningEffort,
    streamOptions: provider?.streamOptions,
  }
}

/** Shared transport pieces a provider's client may need. */
export type ProviderTransport = {
  /**
   * Fetch wrapper that routes the request through the Rayu gateway for
   * active-user tracking, or undefined to call the provider directly. Fails safe
   * to a direct call at request time (see gatewayRouting.shouldRouteViaGateway).
   */
  gatewayFetch?: typeof fetch
  /**
   * Anthropic SDK transport options (default headers, API_TIMEOUT_MS timeout,
   * proxy fetchOptions, debug logger, fetch override) shared by every
   * Anthropic-Messages provider so they cannot drift apart.
   */
  anthropicOptions: Partial<ClientOptions>
}

/**
 * Resolve the transport (gateway routing + Anthropic SDK options) for a
 * provider. Kept separate from `buildClient` so a branch can opt into exactly
 * the pieces it needs.
 */
export async function resolveTransport(
  provider: RayuProvider,
  opts: { source?: string; fetchOverride?: ClientOptions['fetch'] } = {},
): Promise<ProviderTransport> {
  const { shouldRouteViaGateway, makeGatewayRoutingFetch } = await import(
    './rayuHosted/gatewayRouting.js'
  )
  const gatewayFetch = shouldRouteViaGateway(provider)
    ? makeGatewayRoutingFetch(provider)
    : undefined
  return {
    gatewayFetch,
    anthropicOptions: anthropicTransportOptions({
      source: opts.source,
      fetchOverride: opts.fetchOverride,
    }),
  }
}

export type BuildClientOptions = {
  maxRetries: number
  /** Bare or provider-encoded model id; used for per-model format resolution. */
  model?: string
  /** Query source, threaded into request debug logging. */
  source?: string
  /** Caller-supplied fetch (tests / SDK consumers). */
  fetchOverride?: ClientOptions['fetch']
  /**
   * Whether RAYU_OPENAI_BASE_URL / RAYU_OPENAI_API_KEY may override the
   * provider's stored base URL and key. True only for the ACTIVE provider, which
   * is how those CI/test overrides behaved before this refactor: a subagent
   * routed to a specific provider must keep that provider's own credentials.
   */
  allowEnvOverrides?: boolean
}

/**
 * Build an API client for a SPECIFIC provider. Returns null when this provider
 * cannot be served here, so the caller falls through (first-party Anthropic is
 * still constructed in client.ts because it owns OAuth refresh, the apiKeyHelper
 * chain, and first-party-only headers).
 *
 * This is a thin executor over `resolveClientTarget` — all routing logic lives
 * there so it can be verified exhaustively without constructing SDK clients.
 */
export async function buildClient(
  provider: RayuProvider,
  opts: BuildClientOptions,
): Promise<unknown | null> {
  const { maxRetries, source, fetchOverride, allowEnvOverrides } = opts
  const target = resolveClientTarget(provider, opts.model, { allowEnvOverrides })

  switch (target) {
    // Built by buildFirstPartyAnthropicClient (OAuth refresh, apiKeyHelper chain,
    // first-party-only headers). Returned as null here so client.ts owns the
    // "no provider configured at all" fallback too.
    case 'first-party-anthropic':
      return null

    case 'anthropic-compatible': {
      // A BYO-key third-party Anthropic Messages endpoint at a custom baseURL
      // with Bearer auth (LongCat, Ollama Cloud).
      const apiKeys = await resolveProviderApiKeys(provider)
      const { gatewayFetch } = await resolveTransport(provider)
      return createAnthropicMessagesClient({
        maxRetries,
        auth: {
          mode: 'bearer',
          keys: apiKeys.length ? apiKeys : [provider.apiKey ?? ''],
        },
        baseURL: provider.baseURL,
        source,
        fetchOverride,
        ...(gatewayFetch ? { wrapFetch: () => gatewayFetch } : {}),
      })
    }

    case 'rayu-hosted': {
      // Served by DeepSeek's Anthropic-compatible API behind the Rayu gateway;
      // auth is the account JWT injected by a token-refreshing fetch wrapper.
      const { makeRayuHostedFetch, rayuHostedAnthropicBaseURL } = await import(
        './rayuHosted/rayuHostedAuth.js'
      )
      return createAnthropicMessagesClient({
        maxRetries,
        auth: { mode: 'custom-fetch', fetch: makeRayuHostedFetch() },
        baseURL: rayuHostedAnthropicBaseURL(),
        source,
      })
    }

    case 'bedrock-anthropic': {
      // Claude on Bedrock over the NATIVE Anthropic Messages format: the SHARED
      // Anthropic client, pointed at the region's bedrock-runtime host, with a
      // fetch that rewrites /v1/messages → the Bedrock invoke path and transcodes
      // the AWS event-stream response back into Anthropic SSE.
      //
      // Deliberately NOT @anthropic-ai/bedrock-sdk: that package is present in
      // node_modules but declared in neither package.json nor bun.lock (a stale
      // install artifact the bundler silently inlines), so depending on it would
      // break after a clean install.
      const { makeBedrockAnthropicFetch, bedrockRuntimeBaseURL } = await import(
        './bedrockAnthropic.js'
      )
      const region =
        provider.awsRegion || process.env.AWS_REGION || 'us-east-1'
      const { anthropicOptions, gatewayFetch } = await resolveTransport(
        provider,
        { source, fetchOverride },
      )
      return createAnthropicMessagesClient({
        maxRetries,
        auth: {
          mode: 'custom-fetch',
          fetch: makeBedrockAnthropicFetch({
            apiKey: provider.apiKey ?? '',
            region,
            // Keep the shared transport's request logging + proxy fetch inside.
            inner: (anthropicOptions.fetch ??
              gatewayFetch) as typeof fetch | undefined,
          }),
        },
        baseURL: bedrockRuntimeBaseURL(region),
        source,
      })
    }

    case 'bedrock-converse': {
      // AWS Converse/ConverseStream via the AWS SDK (SigV4 or bearer token).
      const { createBedrockConverseClient } = await import(
        './bedrockConverseAdapter.js'
      )
      return createBedrockConverseClient({
        apiKey: provider.apiKey,
        region: provider.awsRegion,
        maxRetries,
      })
    }

    case 'vertex-genai': {
      const { createVertexGenaiClient } = await import(
        './gemini/vertexGenaiClient.js'
      )
      const { gatewayFetch } = await resolveTransport(provider)
      return createVertexGenaiClient(provider, maxRetries, gatewayFetch)
    }

    case 'genai-code-assist':
      return buildGenAIClient(provider, maxRetries)

    case 'kiro': {
      // AWS CodeWhisperer backend (apikey or kiro-cli OAuth). Lazy-imported so
      // no sqlite read or Kiro adapter loads unless Kiro is in use.
      const { createKiroClient } = await import('./kiro/kiroAdapter.js')
      return createKiroClient(provider, maxRetries)
    }

    case 'copilot': {
      // OpenAI-compatible api.githubcopilot.com behind a short-lived Copilot
      // token refreshed from the stored GitHub OAuth token.
      const { createCopilotClient } = await import('./copilot/copilotClient.js')
      return createCopilotClient(provider, maxRetries)
    }

    case 'openai-chat': {
      const config = await resolveOpenAIChatConfig(provider, {
        maxRetries,
        allowEnvOverrides,
      })
      if (!config) return null
      const { createOpenAICompatibleClient } = await import(
        './openaiAdapter.js'
      )
      const { gatewayFetch } = await resolveTransport(provider)
      return createOpenAICompatibleClient({
        ...config,
        ...(gatewayFetch ? { fetch: gatewayFetch } : {}),
      })
    }

    default:
      return null
  }
}

/**
 * Build the FIRST-PARTY Anthropic client (api.anthropic.com).
 *
 * This is the original upstream call path and carries everything that is
 * first-party-only:
 *   • OAuth token refresh + the apiKeyHelper credential chain
 *   • the staging base URL under USER_TYPE=ant + USE_STAGING_OAUTH
 *   • container / remote-session / client-app identification headers
 *   • x-anthropic-additional-protection
 *   • ANTHROPIC_CUSTOM_HEADERS, X-Claude-Code-Session-Id and x-client-request-id
 *     (applied by the shared transport under `firstParty: true`)
 *   • Rayu gateway routing for active-user tracking
 *
 * It shares the SAME construction path as every other Anthropic-Messages
 * provider (createAnthropicMessagesClient); only the auth mode, the endpoint and
 * the first-party flag differ.
 */
export async function buildFirstPartyAnthropicClient(opts: {
  maxRetries: number
  /** Explicit key from the caller; falls back to the credential chain. */
  apiKey?: string
  source?: string
  fetchOverride?: ClientOptions['fetch']
  /** The active provider, when it is the first-party one (for gateway routing). */
  provider?: RayuProvider
}): Promise<Anthropic> {
  const { maxRetries, apiKey, source, fetchOverride, provider } = opts
  const { checkAndRefreshOAuthTokenIfNeeded, getAnthropicApiKey } = await import(
    'src/utils/auth.js'
  )
  const { getIsNonInteractiveSession } = await import(
    '../../bootstrap/state.js'
  )
  const { isDebugToStdErr, logForDebugging } = await import(
    '../../utils/debug.js'
  )
  const { isEnvTruthy } = await import('../../utils/envUtils.js')
  const { getOauthConfig } = await import('../../constants/oauth.js')
  const { getCustomHeaders } = await import('./anthropicTransport.js')
  void isDebugToStdErr

  const containerId = process.env.CLAUDE_CODE_CONTAINER_ID
  const remoteSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
  const customHeaders = getCustomHeaders()
  const extraHeaders: Record<string, string> = {
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
  if (isEnvTruthy(process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION)) {
    extraHeaders['x-anthropic-additional-protection'] = 'true'
  }

  logForDebugging('[API:auth] OAuth token check starting')
  await checkAndRefreshOAuthTokenIfNeeded()
  logForDebugging('[API:auth] OAuth token check complete')

  // Rayu: an explicit auth token replaces x-api-key with a Bearer header.
  void getIsNonInteractiveSession()
  const authTokenOverride = process.env.RAYU_ANTHROPIC_AUTH_TOKEN
  if (authTokenOverride) {
    extraHeaders['Authorization'] = `Bearer ${authTokenOverride}`
  }

  // Rayu: when opted-in + signed in and the active provider is first-party
  // Anthropic (an API-key provider), route its requests through the gateway
  // proxy for active-user tracking. The wrapper fails safe to a direct call if
  // the gateway is down. Non-first-party providers never reach this function.
  let wrapFetch: ((inner: typeof fetch) => typeof fetch) | undefined
  try {
    if (provider?.kind === 'anthropic') {
      const { shouldRouteViaGateway, makeGatewayRoutingFetch } = await import(
        './rayuHosted/gatewayRouting.js'
      )
      if (shouldRouteViaGateway(provider)) {
        wrapFetch = inner =>
          makeGatewayRoutingFetch(provider, inner) as typeof fetch
      }
    }
  } catch {
    // never let routing setup break Anthropic client creation
  }

  return createAnthropicMessagesClient({
    maxRetries,
    firstParty: true,
    auth: {
      mode: 'x-api-key',
      apiKey: apiKey || getAnthropicApiKey() || undefined,
    },
    // Staging OAuth points the SDK at the staging API (ant users only).
    ...(process.env.USER_TYPE === 'ant' &&
    isEnvTruthy(process.env.USE_STAGING_OAUTH)
      ? { baseURL: getOauthConfig().BASE_API_URL }
      : {}),
    source,
    fetchOverride,
    extraHeaders,
    ...(wrapFetch ? { wrapFetch } : {}),
  })
}

/** Login-with-Gemini: the free Code Assist backend, no GCP project required. */
async function buildGenAIClient(
  provider: RayuProvider,
  maxRetries: number,
): Promise<unknown | null> {
  const { createCodeAssistClient } = await import(
    './gemini/codeAssistClient.js'
  )
  const { getGeminiLoginAccessToken } = await import(
    '../oauth/geminiLogin.js'
  )
  return createCodeAssistClient({
    maxRetries,
    providerId: provider.id,
    getToken: async () => {
      const r = await getGeminiLoginAccessToken()
      if (!r?.token) {
        throw new Error(
          'Not signed in to Gemini. Run /connect → Login with Gemini.',
        )
      }
      return r.token
    },
  })
}

/**
 * The env-only OpenAI-compatible escape hatch: RAYU_OPENAI_COMPATIBLE=1 with
 * RAYU_OPENAI_BASE_URL, used for headless/CI runs with no saved provider (or
 * with a first-party Anthropic provider saved). Kept separate from `buildClient`
 * because there may be no provider object to key off.
 */
export async function buildEnvOpenAIChatClient(
  provider: RayuProvider | undefined,
  maxRetries: number,
): Promise<unknown | null> {
  const config = await resolveOpenAIChatConfig(provider, {
    maxRetries,
    allowEnvOverrides: true,
  })
  if (!config) return null
  const { createOpenAICompatibleClient } = await import('./openaiAdapter.js')
  const gatewayFetch = provider
    ? (await resolveTransport(provider)).gatewayFetch
    : undefined
  return createOpenAICompatibleClient({
    ...config,
    ...(gatewayFetch ? { fetch: gatewayFetch } : {}),
  })
}

