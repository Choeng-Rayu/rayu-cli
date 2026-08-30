// Per-request provider shape: what will ACTUALLY be sent, for THIS model.
//
// THE PROBLEM THIS SOLVES
// Rayu can run several providers concurrently in different roles: the main agent
// on one provider, a subagent or swarm collaborator on another (the model string
// carries a `providerId\u0000` routing prefix — see rayuConfig.encodeModelWithProvider,
// produced by utils/model/agent.ts and consumed by services/api/client.ts).
//
// Request-shaping decisions (does this support extended thinking? adaptive
// thinking? the effort param? first-party-only betas?) were previously made by
// global "is X active?" predicates that read getActiveProvider(). For a
// cross-provider subagent those answered for the WRONG provider: with the main
// agent on Claude and a collaborator on DeepSeek, the DeepSeek request was shaped
// for Claude, and vice versa.
//
// A second, newer reason: one provider entry can now serve SEVERAL wire formats
// (a Bedrock provider serves Claude over Anthropic Messages and gpt-oss over
// OpenAI Chat; an Azure resource serves Claude and GPT; a Vertex provider serves
// three formats). A provider-level boolean cannot answer correctly for such a
// provider at all — only a (provider, model) pair can.
//
// So every request-shaping call site resolves the shape from the MODEL STRING it
// already has, which is the same string the transport layer routes on.
//
// The predicates in utils/model/providers.ts are NOT removed: questions that are
// genuinely about the session as a whole — what to show in /status, whether to
// preconnect, which model the picker should offer, whether to call Anthropic's
// policy-limits endpoint — legitimately ask about the ACTIVE provider and keep
// using them.
import type { RayuProvider, WireFormat } from '../rayuConfig.js'

export type RequestShape = {
  /** The provider that will serve this request (routed, else active). */
  provider: RayuProvider | undefined
  /** The wire format the request will be sent in. */
  format: WireFormat
  /**
   * True only for genuine first-party api.anthropic.com traffic: a
   * kind:'anthropic' provider (or no provider at all) that is not pointed at a
   * proxy via ANTHROPIC_BASE_URL. Gates first-party-only request features.
   */
  firstParty: boolean
  /** The request body is Anthropic Messages (the internal IR, untranslated). */
  anthropicFormat: boolean
  /** The request body is one of the two OpenAI protocols. */
  openaiFormat: boolean
  /**
   * A BYO-key THIRD-PARTY Anthropic Messages endpoint (kind:'anthropic-compatible'
   * — LongCat, Ollama Cloud). These speak the native wire format but do not
   * implement Claude-only request extensions such as
   * `thinking:{type:'adaptive'}`, so they need the standard
   * `{type:'enabled',budget_tokens}` form instead.
   */
  anthropicCompatibleEndpoint: boolean
}

/**
 * Resolve the provider a request will be served by.
 *
 * A `providerId\u0000model` prefix (a subagent/collaborator routed elsewhere)
 * wins; otherwise the active provider. Mirrors client.ts's own resolution so the
 * shape used to BUILD a request always matches the client that SENDS it.
 */
function resolveProvider(model?: string): RayuProvider | undefined {
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { decodeModelProvider, getActiveProvider, loadRayuConfig } =
      require('../rayuConfig.js') as typeof import('../rayuConfig.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (model) {
      const { providerId } = decodeModelProvider(model)
      if (providerId) {
        const routed = loadRayuConfig().providers.find(p => p.id === providerId)
        if (routed) return routed
      }
    }
    return getActiveProvider()
  } catch {
    return undefined
  }
}

/**
 * Resolve what will actually be sent for a (provider, model) pair.
 *
 * Imports are lazy `require()`s: this module sits between the model layer and the
 * request layer, both of which import each other's leaves, and the codebase's
 * established way to break those cycles (see utils/context.ts, providers.ts,
 * model/agent.ts) is a lazy require. `require` is cached, so the hot path pays
 * only a map lookup.
 */
export function resolveRequestShape(model?: string): RequestShape {
  const provider = resolveProvider(model)

  let format: WireFormat = 'anthropic-messages'
  let firstParty = true
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { resolveWireFormat } =
      require('../../services/api/providerRegistry.js') as typeof import('../../services/api/providerRegistry.js')
    const { isFirstPartyAnthropicBaseUrl } =
      require('./providers.js') as typeof import('./providers.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (provider) {
      format = resolveWireFormat(provider, model)
      // Only a kind:'anthropic' provider is first-party, and only when it is not
      // pointed at a proxy via ANTHROPIC_BASE_URL.
      firstParty = provider.kind === 'anthropic' && isFirstPartyAnthropicBaseUrl()
    } else {
      // No configured provider: the first-party Anthropic path, unless the
      // env-only OpenAI escape hatch is in play (RAYU_OPENAI_COMPATIBLE=1).
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { isOpenAICompatibleActive } =
        require('./providers.js') as typeof import('./providers.js')
      /* eslint-enable @typescript-eslint/no-require-imports */
      if (isOpenAICompatibleActive()) {
        format = 'openai-chat'
        firstParty = false
      } else {
        firstParty = isFirstPartyAnthropicBaseUrl()
      }
    }
  } catch {
    // Fall back to the safest assumption: first-party Anthropic semantics.
  }

  return {
    provider,
    format,
    firstParty,
    anthropicFormat: format === 'anthropic-messages',
    openaiFormat: format === 'openai-chat' || format === 'openai-responses',
    anthropicCompatibleEndpoint: provider?.kind === 'anthropic-compatible',
  }
}

/**
 * True when the request will NOT be an Anthropic Messages request — i.e. it is
 * translated into another protocol (OpenAI Chat/Responses, GenAI, CodeWhisperer).
 *
 * This is the per-model replacement for the
 * `isOpenAICompatibleActive() || (isRayuNonAnthropicActive() && !isClaudeModelOrAlias(model))`
 * idiom that was repeated across thinking/effort/context: those adapters
 * translate Rayu's thinking/effort parameters into the target protocol's own
 * fields, so the capability is available regardless of Claude's per-family rules.
 */
export function usesTranslatedFormat(model?: string): boolean {
  return !resolveRequestShape(model).anthropicFormat
}

/**
 * True when the request goes to a genuine first-party api.anthropic.com endpoint.
 * Gates first-party-only request features (experimental betas, global prompt-cache
 * scope, fine-grained tool streaming, the tool-search beta).
 */
export function isFirstPartyRequest(model?: string): boolean {
  return resolveRequestShape(model).firstParty
}

/**
 * False only when we POSITIVELY know the model that will serve this request
 * cannot accept image content — either the resolved provider declared it (the
 * `supportsImage` toggle in /connect → Custom, or a per-model
 * `modelSupportsImage` entry) or the model is in the built-in text-only table.
 *
 * Delegates to resolveImageSupport (utils/model/imageCapability.ts). It used to
 * read `provider.supportsImage !== false` directly, which was provider-wide and
 * so could not answer for a provider serving both text-only and vision models
 * (DeepSeek's `deepseek-chat` next to `deepseek-vl`). Name and signature are
 * unchanged, so the adapter call sites became model-aware without edits.
 *
 * An UNKNOWN model still returns true: the tables can never be complete, and
 * suppressing images for an unlisted-but-capable model would be a regression.
 * The reactive recovery path handles a wrong guess.
 */
export function providerAcceptsImages(model?: string): boolean {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { modelAcceptsImages } =
    require('./imageCapability.js') as typeof import('./imageCapability.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  return modelAcceptsImages(model)
}
