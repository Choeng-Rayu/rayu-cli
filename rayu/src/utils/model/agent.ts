import type { PermissionMode } from '../permissions/PermissionMode.js'
import { capitalize } from '../stringUtils.js'
import { MODEL_ALIASES, isClaudeModelOrAlias } from './aliases.js'
import { applyBedrockRegionPrefix, getBedrockRegionPrefix } from './bedrock.js'
import { isModelAllowed } from './modelAllowlist.js'
import {
  getCanonicalName,
  getRuntimeMainLoopModel,
  parseUserSpecifiedModel,
  getSmallFastModel,
} from './model.js'
import { getAPIProvider, isOpenAICompatibleActive, isRayuHostedActive, isRayuNonAnthropicActive } from './providers.js'


function resolveOpenAICompatibleAgentModel(
  requested: string,
  parentModel: string,
): string {
  const trimmed = requested.trim()
  const normalized = trimmed.toLowerCase()
  if (normalized === 'inherit') {
    return parentModel
  }
  if (normalized === 'haiku' || normalized.startsWith('claude-3-5-haiku') || normalized.startsWith('claude-haiku')) {
    return getSmallFastModel()
  }
  if (isClaudeModelOrAlias(trimmed)) {
    return parentModel
  }
  return trimmed
}

/** The slice of a provider record a catalog check needs. */
type CatalogProvider = {
  id: string
  kind?: string
  fetchedModels?: string[]
  smallFastModel?: string
  subagentTierModels?: Partial<Record<'fast' | 'balanced' | 'capable', string>>
}

/**
 * Rayu's two providers — 'rayu-hosted' (account JWT) and 'rayu' (API key) —
 * serve a SERVER-driven catalog. The only ids that work are the ones the
 * account/plan published into `fetchedModels`; there is no built-in table to
 * fall back on. Every other provider kind is judged by the request layer, not
 * here.
 */
function isRayuCatalogProvider(p: CatalogProvider | undefined): p is CatalogProvider {
  return !!p && (p.kind === 'rayu-hosted' || p.id === 'rayu')
}

/**
 * The Rayu provider a request carrying `requested` will actually reach: the one
 * encoded in the string when a caller routed it (`providerId\u0000model`), else
 * the active provider. Returns undefined for every non-Rayu target, so callers
 * leave the model untouched.
 */
export function getRayuCatalogProvider(
  requested: string,
): CatalogProvider | undefined {
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { decodeModelProvider, getActiveProvider, loadRayuConfig } =
      require('../rayuConfig.js') as typeof import('../rayuConfig.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    const decoded = decodeModelProvider(requested)
    const provider = decoded.providerId
      ? loadRayuConfig().providers.find(p => p.id === decoded.providerId)
      : getActiveProvider()
    return isRayuCatalogProvider(provider) ? provider : undefined
  } catch {
    return undefined
  }
}

/** The tier words the main agent may pass as a subagent `model`. */
const SUBAGENT_TIERS = ['fast', 'balanced', 'capable'] as const
type SubagentTierWord = (typeof SUBAGENT_TIERS)[number]

function asTierWord(value: string): SubagentTierWord | undefined {
  const lower = value.trim().toLowerCase()
  return (SUBAGENT_TIERS as readonly string[]).includes(lower)
    ? (lower as SubagentTierWord)
    : undefined
}

/**
 * Claude alias → tier. The main agent still reaches for these from habit; on a
 * Rayu provider they mean the tier the admin configured, never a Claude id.
 */
const ALIAS_TIER: Record<string, SubagentTierWord> = {
  haiku: 'fast',
  sonnet: 'balanced',
  'sonnet[1m]': 'balanced',
  opusplan: 'balanced',
  opus: 'capable',
  'opus[1m]': 'capable',
  best: 'capable',
}

/**
 * Tier → the alias the existing non-Rayu resolution already understands, so a
 * tier word is never sent to an API as a literal model id. First-party resolves
 * the alias; OpenAI-compatible maps `haiku` to its small/fast model and the
 * others to the parent model.
 */
const TIER_ALIAS: Record<SubagentTierWord, string> = {
  fast: 'haiku',
  balanced: 'sonnet',
  capable: 'opus',
}

/**
 * Exact match, or a version-prefix match at a separator boundary — asking for
 * `claude-sonnet-4-5` must accept the catalog's dated `claude-sonnet-4-5-20250929`
 * without matching an unrelated `claude-sonnet-4-50`.
 */
function matchCatalogModel(
  catalog: readonly string[],
  requested: string,
): string | undefined {
  const want = requested.trim().toLowerCase()
  if (!want) return undefined
  const exact = catalog.find(m => m.trim().toLowerCase() === want)
  if (exact) return exact
  return catalog.find(m => {
    const id = m.trim().toLowerCase()
    if (!id.startsWith(want)) return false
    const next = id[want.length]
    return next === undefined || next === '-' || next === '/' || next === '@' || next === '.'
  })
}

/**
 * Resolve the Agent tool's per-call `model` against a Rayu provider's catalog.
 *
 * The main agent picks `model` from its own knowledge and never sees this
 * catalog, so it commonly passes a Claude alias ('sonnet'/'haiku') or an id
 * belonging to another vendor. `parseUserSpecifiedModel` would expand an alias
 * into a Claude id the gateway has never heard of, and the spawn would fail
 * with a 404 the caller cannot recover from.
 *
 * Tier words (`fast` / `balanced` / `capable`) and Claude aliases resolve to the
 * model the admin assigned to that tier. An unset tier, or an id the provider
 * does not serve, returns undefined: the caller then falls back to the
 * /subagent_models selection or the agent's default instead of failing. An exact
 * catalog id is kept. A provider with no fetched catalog cannot be judged, so a
 * non-tier id is kept unchanged.
 */
export function resolveRayuSubagentModel(
  requested: string | undefined,
  provider: CatalogProvider | undefined,
): string | undefined {
  if (!requested) return undefined
  const trimmed = requested.trim()
  if (!trimmed) return undefined
  // 'inherit' is not a model id — letting it through would put the literal
  // string on the wire. Treat it as "no per-call choice".
  if (trimmed.toLowerCase() === 'inherit') return undefined

  const tier = asTierWord(trimmed) ?? ALIAS_TIER[trimmed.toLowerCase()]
  if (!provider) {
    // Not a Rayu provider: translate a tier word into the alias the normal
    // resolution understands, never forwarding "fast" as a model id.
    const word = asTierWord(trimmed)
    return word ? TIER_ALIAS[word] : trimmed
  }

  const catalog = (provider.fetchedModels ?? []).filter(m => !!m)

  // An exact catalog id is an explicit choice and wins over tier mapping.
  if (catalog.length > 0) {
    const direct = matchCatalogModel(catalog, trimmed)
    if (direct) return direct
  }

  if (tier) {
    // Only the admin's tier assignment decides; an unset tier means "default".
    const code = provider.subagentTierModels?.[tier]
    if (!code) return undefined
    return catalog.length === 0 ? code : matchCatalogModel(catalog, code)
  }

  // An unrecognised id: keep it when the catalog is unknown, drop it otherwise.
  return catalog.length === 0 ? trimmed : undefined
}

export const AGENT_MODEL_OPTIONS = [...MODEL_ALIASES, 'inherit'] as const
export type AgentModelAlias = (typeof AGENT_MODEL_OPTIONS)[number]

/**
 * Resolve the provider + model a (default) subagent should run on, for
 * multi-provider mode. Precedence:
 *  1. The user's configured agent selection (/subagent_models), which may
 *     target a DIFFERENT provider than the main agent.
 *  2. Rayu-hosted, if configured — even when the main session is on a
 *     third-party provider. The managed gateway is always preferred so
 *     subagents benefit from credit tracking and provider routing.
 *  3. The active provider's instant/small-fast model as a final fallback.
 *
 * Returns { providerId, model }. The caller encodes these into the request
 * model (encodeModelWithProvider) only when providerId differs from the active
 * provider, so a different-provider subagent routes correctly and concurrently.
 */
export function resolveSubagentExecution(agentType?: string): {
  providerId: string
  model: string
} | undefined {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const {
    getSubagentSelection,
    getActiveProvider,
    getValidDefaultModel,
    loadRayuConfig,
  } = require('../rayuConfig.js') as typeof import('../rayuConfig.js')
  /* eslint-enable @typescript-eslint/no-require-imports */

  const sel = getSubagentSelection(agentType)
  if (sel) return { providerId: sel.providerId, model: sel.model }

  // Prefer rayu-hosted when it is configured, even when the main session is on
  // a third-party provider. The rayu gateway is the managed path so subagents
  // default to it. The id 'rayu' (RAYU_API_PROVIDER_ID) is inlined here to
  // avoid a circular dependency — kept in sync with rayuConfig.ts.
  const allProviders = loadRayuConfig().providers
  const rayuHosted = allProviders.find(
    (p) => p.kind === 'rayu-hosted' || p.id === 'rayu',
  )
  if (rayuHosted) {
    const model =
      rayuHosted.smallFastModel ||
      getValidDefaultModel(rayuHosted) ||
      rayuHosted.defaultModel
    if (model) return { providerId: rayuHosted.id, model }
  }

  const active = getActiveProvider()
  if (!active) return undefined
  const instant =
    active.smallFastModel || getValidDefaultModel(active) || active.defaultModel
  if (!instant) return undefined
  return { providerId: active.id, model: instant }
}

export type AgentModelOption = {
  value: AgentModelAlias
  label: string
  description: string
}

/**
 * Get the default subagent model. Returns 'inherit', which resolves to the
 * parent/main agent's own model, so an agent definition that pins no model (and
 * has no env/selection/tool override) runs on the model the main agent is on.
 */
export function getDefaultSubagentModel(): string {
  return 'inherit'
}

/**
 * Get the effective model string for an agent.
 *
 * For Bedrock, if the parent model uses a cross-region inference prefix (e.g., "eu.", "us."),
 * that prefix is inherited by subagents using alias models (e.g., "sonnet", "haiku", "opus").
 * This ensures subagents use the same region as the parent, which is necessary when
 * IAM permissions are scoped to specific cross-region inference profiles.
 */
export function getAgentModel(
  agentModel: string | undefined,
  parentModel: string,
  toolSpecifiedModelParam?: string,
  permissionMode?: PermissionMode,
  agentType?: string,
): string {
  // A per-call `model` chosen by the main agent is only meaningful if the
  // provider serving this request can run it. Rayu's providers serve a
  // server-driven catalog the main agent cannot see, so an alias or a
  // guessed id would otherwise be forwarded and fail the whole spawn.
  // An unavailable id resolves to undefined: the normal fallback below
  // (saved selection, then the agent's own default) decides instead.
  const toolSpecifiedModel =
    toolSpecifiedModelParam === undefined
      ? undefined
      : resolveRayuSubagentModel(
          toolSpecifiedModelParam,
          getRayuCatalogProvider(toolSpecifiedModelParam),
        )

  // Rayu multi-provider agent routing. A selection saved by /subagent_models
  // is a FALLBACK DEFAULT for spawned Agent-tool workers, including definitions
  // whose built-in default is `inherit` (for example general-purpose). A named
  // selection is preferred over the global one because
  // getSubagentSelection(agentType) checks it before the global selection. The
  // Agent tool's per-call `model` param OVERRIDES a saved selection, so the main
  // agent can pick a model for a specific spawn while the user's saved choice
  // stays the default for calls that don't specify one. Only
  // CLAUDE_CODE_SUBAGENT_MODEL ranks higher. If the selected provider differs
  // from the active provider, the encoded provider+model route sends that
  // worker to the selected provider.
  // Precedence: env var > tool `model` param > saved selection > agent-def
  // model (env override only) > the main agent's own model.
  let configuredSelection:
    | { providerId: string; model: string }
    | undefined
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { getSubagentSelection } =
      require('../rayuConfig.js') as typeof import('../rayuConfig.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    configuredSelection = getSubagentSelection(agentType)
  } catch {
    configuredSelection = undefined
  }

  if (!process.env.CLAUDE_CODE_SUBAGENT_MODEL && !toolSpecifiedModel && configuredSelection) {
    if (!isModelAllowed(configuredSelection.model)) {
      return getRuntimeMainLoopModel({
        permissionMode: permissionMode ?? 'default',
        mainLoopModel: parentModel,
        exceeds200kTokens: false,
      })
    }

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { encodeModelWithProvider, getActiveProvider } =
      require('../rayuConfig.js') as typeof import('../rayuConfig.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    return configuredSelection.providerId !== getActiveProvider()?.id
      ? encodeModelWithProvider(
          configuredSelection.providerId,
          configuredSelection.model,
        )
      : configuredSelection.model
  }

  // With no saved choice, an agent that EXPLICITLY asks for the fast tier
  // ('haiku') falls back to the active provider's instant/small-fast model. An
  // UNSET model is not a fast-tier request — it resolves to the main agent's
  // own model below.
  if (
    !process.env.CLAUDE_CODE_SUBAGENT_MODEL &&
    !toolSpecifiedModel &&
    agentModel?.toLowerCase() === 'haiku' &&
    isRayuNonAnthropicActive()
  ) {
    const sub = resolveSubagentExecution(agentType)
    if (sub) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { getActiveProvider, encodeModelWithProvider } =
        require('../rayuConfig.js') as typeof import('../rayuConfig.js')
      /* eslint-enable @typescript-eslint/no-require-imports */
      const activeId = getActiveProvider()?.id
      return sub.providerId !== activeId
        ? encodeModelWithProvider(sub.providerId, sub.model)
        : sub.model
    }
  }

  // When an agent has NO model pin at all (undefined) and the main session is
  // NOT already on rayu-hosted, prefer rayu-hosted if it is configured — using
  // its default (not fast) model so capability matches the user's expectation.
  // agentModel==='haiku' is handled above; agentModel==='inherit' or any alias
  // is an explicit choice and falls through. Only undefined (no pin at all) triggers
  // this. If rayu-hosted IS the active provider, parentModel already routes there.
  if (
    !process.env.CLAUDE_CODE_SUBAGENT_MODEL &&
    !toolSpecifiedModel &&
    agentModel === undefined &&
    !isRayuHostedActive()
  ) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const {
      loadRayuConfig,
      getValidDefaultModel,
      getActiveProvider,
      encodeModelWithProvider,
    } = require('../rayuConfig.js') as typeof import('../rayuConfig.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    const rayuHosted = loadRayuConfig().providers.find(
      (p) => p.kind === 'rayu-hosted' || p.id === 'rayu',
    )
    if (rayuHosted) {
      const model = getValidDefaultModel(rayuHosted) || rayuHosted.defaultModel
      if (model) {
        const activeId = getActiveProvider()?.id
        return rayuHosted.id !== activeId
          ? encodeModelWithProvider(rayuHosted.id, model)
          : model
      }
    }
  }

  if (isOpenAICompatibleActive()) {
    if (process.env.CLAUDE_CODE_SUBAGENT_MODEL) {
      return resolveOpenAICompatibleAgentModel(process.env.CLAUDE_CODE_SUBAGENT_MODEL, parentModel)
    }
    if (toolSpecifiedModel) {
      return resolveOpenAICompatibleAgentModel(toolSpecifiedModel, parentModel)
    }
    const agentModelWithExp = agentModel ?? getDefaultSubagentModel()
    return resolveOpenAICompatibleAgentModel(agentModelWithExp, parentModel)
  }

  if (process.env.CLAUDE_CODE_SUBAGENT_MODEL) {
    return parseUserSpecifiedModel(process.env.CLAUDE_CODE_SUBAGENT_MODEL)
  }

  // Extract Bedrock region prefix from parent model to inherit for subagents.
  // This ensures subagents use the same cross-region inference profile (e.g., "eu.", "us.")
  // as the parent, which is required when IAM permissions only allow specific regions.
  const parentRegionPrefix = getBedrockRegionPrefix(parentModel)

  // Helper to apply parent region prefix for Bedrock models.
  // `originalSpec` is the raw model string before resolution (alias or full ID).
  // If the user explicitly specified a full model ID that already carries its own
  // region prefix (e.g., "eu.anthropic.…"), we preserve it instead of overwriting
  // with the parent's prefix. This prevents silent data-residency violations when
  // an agent config intentionally pins to a different region than the parent.
  const applyParentRegionPrefix = (
    resolvedModel: string,
    originalSpec: string,
  ): string => {
    if (parentRegionPrefix && getAPIProvider() === 'bedrock') {
      if (getBedrockRegionPrefix(originalSpec)) return resolvedModel
      return applyBedrockRegionPrefix(resolvedModel, parentRegionPrefix)
    }
    return resolvedModel
  }

  // Prioritize tool-specified model if provided
  if (toolSpecifiedModel) {
    if (aliasMatchesParentTier(toolSpecifiedModel, parentModel)) {
      return parentModel
    }
    const model = parseUserSpecifiedModel(toolSpecifiedModel)
    return applyParentRegionPrefix(model, toolSpecifiedModel)
  }

  const agentModelWithExp = agentModel ?? getDefaultSubagentModel()

  if (agentModelWithExp === 'inherit') {
    // Apply runtime model resolution for inherit to get the effective model
    // This ensures agents using 'inherit' get opusplan→Opus resolution in plan mode
    return getRuntimeMainLoopModel({
      permissionMode: permissionMode ?? 'default',
      mainLoopModel: parentModel,
      exceeds200kTokens: false,
    })
  }

  // Callback-to-inherit: an agent model choice (set via /subagent_models or
  // a hardcoded agent default) that the admin-configured
  // availableModels allowlist no longer permits — e.g. the allowlist was
  // tightened after the selection was saved — must NOT be sent to the API.
  // Silently resolve as 'inherit' instead of forwarding a disallowed model
  // string, so the subagent falls back to the Orchestrator's
  // own (already-allowed) model rather than failing the whole spawn.
  // toolSpecifiedModel is handled above this point and is intentionally not
  // covered by this fallback — it's an explicit, single-call override the
  // caller just made and is expected to already be a valid choice.
  if (!isModelAllowed(agentModelWithExp)) {
    return getRuntimeMainLoopModel({
      permissionMode: permissionMode ?? 'default',
      mainLoopModel: parentModel,
      exceeds200kTokens: false,
    })
  }

  if (aliasMatchesParentTier(agentModelWithExp, parentModel)) {
    return parentModel
  }
  const model = parseUserSpecifiedModel(agentModelWithExp)
  return applyParentRegionPrefix(model, agentModelWithExp)
}

/**
 * Check if a bare family alias (opus/sonnet/haiku) matches the parent model's
 * tier. When it does, the subagent inherits the parent's exact model string
 * instead of resolving the alias to a provider default.
 *
 * Prevents surprising downgrades: a Vertex user on Opus 4.6 (via /model) who
 * spawns a subagent with `model: opus` should get Opus 4.6, not whatever
 * getDefaultOpusModel() returns for 3P.
 * See https://github.com/anthropics/claude-code/issues/30815.
 *
 * Only bare family aliases match. `opus[1m]`, `best`, `opusplan` fall through
 * since they carry semantics beyond "same tier as parent".
 */
function aliasMatchesParentTier(alias: string, parentModel: string): boolean {
  const canonical = getCanonicalName(parentModel)
  switch (alias.toLowerCase()) {
    case 'opus':
      return canonical.includes('opus')
    case 'sonnet':
      return canonical.includes('sonnet')
    case 'haiku':
      return canonical.includes('haiku')
    default:
      return false
  }
}

export function getAgentModelDisplay(model: string | undefined): string {
  // When model is omitted, getDefaultSubagentModel() returns 'inherit' at runtime
  if (!model) return 'Inherit from parent (default)'
  if (model === 'inherit') return 'Inherit from parent'
  // Strip any provider-routing prefix (providerId\u0000model) for display.
  const sep = model.indexOf('\u0000')
  if (sep !== -1) {
    return `${model.slice(sep + 1)} (${model.slice(0, sep)})`
  }
  return capitalize(model)
}

/**
 * Get available model options for agents
 */
export function getAgentModelOptions(): AgentModelOption[] {
  return [
    {
      value: 'sonnet',
      label: 'Sonnet',
      description: 'Balanced performance - best for most agents',
    },
    {
      value: 'opus',
      label: 'Opus',
      description: 'Most capable for complex reasoning tasks',
    },
    {
      value: 'haiku',
      label: 'Haiku',
      description: 'Fast and efficient for simple tasks',
    },
    {
      value: 'inherit',
      label: 'Inherit from parent',
      description: 'Use the same model as the main conversation',
    },
  ]
}
