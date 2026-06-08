// Rayu provider configuration store. Persists user-supplied providers
// (id, apiKey, baseURL, default model) to ~/.rayu/providers.json.
//
// SECURITY: API keys are secrets. They are written to a 0600 file and are
// never logged or echoed; callers reference providers by id, not by key value.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getRayuConfigHomeDir } from './envUtils.js'
import { clearContextPrepCache } from './contextPrepCache.js'
import { reportBug, reportIssue, reportVulnerability } from './rayuDiagnostics.js'

export type ProviderKind = 'anthropic' | 'openai-compatible' | 'bedrock' | 'vertex' | 'genai'
export type ProviderFeatureMode = 'auto' | 'enabled' | 'disabled'

export type RayuProvider = {
  /** Stable id, e.g. 'anthropic', 'nvidia', 'openai', 'openrouter', 'local', 'bedrock'. */
  id: string
  kind: ProviderKind
  apiKey?: string
  /** Base URL for openai-compatible providers (ignored for first-party anthropic). */
  baseURL?: string
  /** Default model id for this provider. */
  defaultModel?: string
  /** Optional small/fast model id for cheap requests (titles, etc.). */
  smallFastModel?: string
  /** Default context-window (tokens) for this provider's models. */
  contextWindow?: number
  /** Per-model context-window (tokens) overrides, keyed by model id. */
  modelContextWindows?: Record<string, number>
  /** User-listed model ids selectable via /model (openai-compatible). */
  models?: string[]
  /** Models fetched live from {baseURL}/models, cached for the /model picker. */
  fetchedModels?: string[]
  /** Optional OpenAI-specific prompt cache routing mode. */
  promptCacheKey?: ProviderFeatureMode
  /** Optional OpenAI-compatible reasoning_effort request parameter mode. */
  reasoningEffort?: ProviderFeatureMode
  /** Optional OpenAI stream_options.include_usage request parameter mode. */
  streamOptions?: ProviderFeatureMode
  // --- AWS Bedrock fields (kind: 'bedrock') ---
  /**
   * Which Bedrock API surface this provider uses:
   * - 'openai' (default): OpenAI-compatible Chat Completions endpoint, for
   *   open-weight models (openai.gpt-oss, qwen, deepseek, ...).
   * - 'anthropic': Anthropic Messages API (via @anthropic-ai/bedrock-sdk),
   *   for Claude models invoked with cross-region inference-profile ids.
   */
  bedrockApi?: 'openai' | 'anthropic'
  /** AWS Access Key ID. SECURITY: stored in 0600 config file. */
  awsAccessKeyId?: string
  /** AWS Secret Access Key. SECURITY: stored in 0600 config file. */
  awsSecretAccessKey?: string
  /** AWS region for Bedrock API calls (default: us-east-1). */
  awsRegion?: string
  // --- Google Vertex AI fields (kind: 'vertex') ---
  /** GCP project id for Vertex AI requests. */
  gcpProject?: string
  /** GCP region (location) for Vertex AI requests (default: us-central1). */
  gcpRegion?: string
}

export type RayuConfig = {
  /** id of the currently active provider. */
  activeProvider?: string
  providers: RayuProvider[]
  /**
   * Globally-configured model for built-in subagents (the Agent tool). Lets the
   * subagent run on a DIFFERENT provider than the main agent (e.g. main on
   * Bedrock/Claude, subagents on NVIDIA's fast model). When unset, subagents
   * default to the main provider's instant/small-fast model.
   *
   * Shaped as a single selection for now; kept as an object so it can grow into
   * per-specialty selections later (e.g. subagentsBySpecialty) without a
   * breaking migration.
   */
  subagent?: {
    providerId: string
    model: string
  }
  /**
   * Per-specialist overrides keyed by agent type (e.g. 'BE-AGENT'). Takes
   * precedence over the global `subagent` selection for that agent. Lets each
   * specialist run on its own provider/model (set via /model_subagent <AGENT>).
   */
  subagentByAgent?: Record<string, { providerId: string; model: string }>
  /**
   * Default model id for the GenerateImage tool (image generation + editing),
   * chosen via /model_image_generation. When unset, the tool uses its NVIDIA
   * default (or Vertex Imagen when that's the only configured backend).
   */
  imageModel?: string
  /**
   * Default model id for the GenerateVideo tool, chosen via
   * /model_video_generation. When unset, the tool uses its NVIDIA/fal default
   * (or Vertex Veo when that's the only configured backend).
   */
  videoModel?: string
}

const FILE_NAME = 'providers.json'

function configPath(): string {
  return join(getRayuConfigHomeDir(), FILE_NAME)
}

let cache: RayuConfig | null = null

/**
 * The providers file holds API keys. If it is group/world-readable, flag a
 * vulnerability so it can be reviewed/tightened (best-effort; POSIX only).
 */
function maybeWarnInsecurePermissions(path: string): void {
  try {
    if (process.platform === 'win32') return
    const mode = statSync(path).mode & 0o777
    if (mode & 0o077) {
      reportVulnerability(
        'rayu_config.insecure_permissions',
        'providers.json (contains API keys) is group/world-accessible',
        { mode: mode.toString(8) },
      )
    }
  } catch {
    // ignore
  }
}

export function loadRayuConfig(): RayuConfig {
  if (cache) return cache
  const path = configPath()
  if (existsSync(path)) {
    try {
      cache = JSON.parse(readFileSync(path, 'utf8')) as RayuConfig
      if (!Array.isArray(cache.providers)) cache.providers = []
      maybeWarnInsecurePermissions(path)
      return cache
    } catch (e) {
      // Corrupt file → start fresh rather than crash, but record it.
      reportBug(
        'rayu_config.parse_failed',
        'providers.json could not be parsed; starting from empty config',
        { error: e instanceof Error ? e.message : String(e) },
      )
    }
  }
  cache = { providers: [] }
  return cache
}

export function saveRayuConfig(config: RayuConfig): void {
  const dir = getRayuConfigHomeDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  // 0600: secrets must not be world/group readable.
  writeFileSync(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 })
  cache = config
  clearContextPrepCache('rayu-config-save')
}

export function getActiveProvider(): RayuProvider | undefined {
  const cfg = loadRayuConfig()
  return (
    cfg.providers.find(p => p.id === cfg.activeProvider) ?? cfg.providers[0]
  )
}

// Model ids that are NOT chat/completions models (embeddings, rerankers, OCR,
// safety/guard, audio/video, etc.) — these 404 on /v1/chat/completions.
const NON_CHAT_MODEL_RE =
  /embed|bge-|rerank|reward|guard|safety|moderation|topic-control|ocr|parse|deplot|nvclip|clip|whisper|tts|stt|video|detector|nemoretriever|content-safety/i

/** Heuristic: is this model id usable on the chat/completions endpoint? */
export function isLikelyChatModel(id: string): boolean {
  return !NON_CHAT_MODEL_RE.test(id)
}

/**
 * A provider's default model, guarded against a stale/mismatched id. If the
 * configured defaultModel isn't present in the fetched catalog (e.g. a preset
 * default that was renamed/re-cased upstream — Doubleword's `moonshotai/kimi-k2-6`
 * vs the catalog's `moonshotai/Kimi-K2.6`), fall back to the first chat-capable
 * fetched model so we don't 404 on every request.
 */
export function getValidDefaultModel(p: RayuProvider | undefined): string | undefined {
  if (!p) return undefined
  const fetched = p.fetchedModels ?? []
  if (p.defaultModel && (fetched.length === 0 || fetched.includes(p.defaultModel))) {
    return p.defaultModel
  }
  return fetched.find(isLikelyChatModel) ?? fetched[0] ?? p.defaultModel
}

export function upsertProvider(provider: RayuProvider, setActive = true): void {
  const cfg = loadRayuConfig()
  const idx = cfg.providers.findIndex(p => p.id === provider.id)
  if (idx >= 0) cfg.providers[idx] = { ...cfg.providers[idx], ...provider }
  else cfg.providers.push(provider)
  if (setActive) cfg.activeProvider = provider.id
  saveRayuConfig(cfg)
}

export function setActiveProvider(id: string): void {
  const cfg = loadRayuConfig()
  if (cfg.providers.some(p => p.id === id)) {
    cfg.activeProvider = id
    saveRayuConfig(cfg)
  }
}

export function setActiveProviderModel(providerId: string, model: string): void {
  const cfg = loadRayuConfig()
  const provider = cfg.providers.find(p => p.id === providerId)
  if (!provider) return
  cfg.activeProvider = providerId
  provider.defaultModel = model
  saveRayuConfig(cfg)
}

/**
 * The globally-configured subagent model selection (provider + model), or
 * undefined when the user hasn't set one (subagents then default to the main
 * provider's instant model — see resolveSubagentExecution in model/agent code).
 */
export function getSubagentSelection(
  agentType?: string,
): { providerId: string; model: string } | undefined {
  const cfg = loadRayuConfig()
  // Per-specialist override wins when present for this agent type.
  if (agentType) {
    const perAgent = cfg.subagentByAgent?.[agentType]
    if (perAgent?.providerId && perAgent?.model) {
      return { providerId: perAgent.providerId, model: perAgent.model }
    }
  }
  const sel = cfg.subagent
  if (!sel || !sel.providerId || !sel.model) return undefined
  return { providerId: sel.providerId, model: sel.model }
}

/**
 * Persist a subagent model selection (set via /model_subagent). With no
 * agentType, sets the GLOBAL default for all subagents. With an agentType
 * (e.g. 'BE-AGENT'), sets a per-specialist override. Does NOT change the active
 * (main) provider — subagents can run on a different provider concurrently.
 */
export function setSubagentSelection(
  providerId: string,
  model: string,
  agentType?: string,
): void {
  const cfg = loadRayuConfig()
  if (agentType) {
    cfg.subagentByAgent = { ...(cfg.subagentByAgent ?? {}), [agentType]: { providerId, model } }
  } else {
    cfg.subagent = { providerId, model }
  }
  saveRayuConfig(cfg)
}

/**
 * Clear a subagent selection. With no agentType, clears the global default.
 * With an agentType, clears just that specialist's override.
 */
export function clearSubagentSelection(agentType?: string): void {
  const cfg = loadRayuConfig()
  let changed = false
  if (agentType) {
    if (cfg.subagentByAgent?.[agentType]) {
      delete cfg.subagentByAgent[agentType]
      if (Object.keys(cfg.subagentByAgent).length === 0) delete cfg.subagentByAgent
      changed = true
    }
  } else if (cfg.subagent) {
    delete cfg.subagent
    changed = true
  }
  if (changed) saveRayuConfig(cfg)
}

/** Default model for the GenerateImage tool (or undefined when unset). */
export function getImageModelSelection(): string | undefined {
  return loadRayuConfig().imageModel || undefined
}

/** Persist the default GenerateImage model (pass undefined to clear). */
export function setImageModelSelection(model: string | undefined): void {
  const cfg = loadRayuConfig()
  if (model) cfg.imageModel = model
  else delete cfg.imageModel
  saveRayuConfig(cfg)
}

/** Default model for the GenerateVideo tool (or undefined when unset). */
export function getVideoModelSelection(): string | undefined {
  return loadRayuConfig().videoModel || undefined
}

/** Persist the default GenerateVideo model (pass undefined to clear). */
export function setVideoModelSelection(model: string | undefined): void {
  const cfg = loadRayuConfig()
  if (model) cfg.videoModel = model
  else delete cfg.videoModel
  saveRayuConfig(cfg)
}

/** True when at least one provider has credentials configured. */
export function hasConfiguredProvider(): boolean {
  return loadRayuConfig().providers.some(
    p => !!p.apiKey || p.kind === 'openai-compatible' || (p.kind === 'bedrock' && !!p.awsAccessKeyId),
  )
}

/** True when the active OpenAI-compatible provider can satisfy Rayu auth itself. */
export function hasUsableOpenAICompatibleProvider(): boolean {
  const p = getActiveProvider()
  if (p?.kind !== 'openai-compatible') {
    return !!process.env.RAYU_OPENAI_BASE_URL && !!process.env.RAYU_OPENAI_API_KEY
  }
  const baseURL = process.env.RAYU_OPENAI_BASE_URL ?? p.baseURL
  const apiKey = process.env.RAYU_OPENAI_API_KEY ?? p.apiKey
  return !!baseURL && (!!apiKey || p.id === 'local')
}

/** API key for the active provider (or a specific provider id), if any. */
export function getRayuApiKey(providerId?: string): string | null {
  const cfg = loadRayuConfig()
  const p = providerId
    ? cfg.providers.find(x => x.id === providerId)
    : getActiveProvider()
  return p?.apiKey ?? null
}

/**
 * Model options across ALL configured non-anthropic Rayu providers, for the
 * /model picker fallback path (keybinding shortcut). Active provider first,
 * then other providers. Any new provider kind (vertex, etc.) is included
 * automatically as long as kind !== 'anthropic'.
 */
export function getActiveProviderModelOptions(): Array<{
  value: string
  label: string
  description: string
}> {
  const cfg = loadRayuConfig()
  const active = getActiveProvider()
  if (!active || active.kind === 'anthropic') return []

  const result: Array<{ value: string; label: string; description: string }> = []
  const seen = new Set<string>()

  const addProvider = (p: RayuProvider) => {
    const ids: string[] = []
    if (p.defaultModel) ids.push(p.defaultModel)
    for (const m of p.models ?? []) ids.push(m)
    for (const m of p.fetchedModels ?? []) ids.push(m)
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id)
        result.push({ value: id, label: id, description: `${p.id} · ${id}` })
      }
    }
  }

  // Active provider first
  addProvider(active)

  // Then all other non-anthropic providers
  for (const p of cfg.providers) {
    if (p.id === active.id) continue
    if (p.kind === 'anthropic') continue
    addProvider(p)
  }

  return result
}

// Best-effort known context windows (tokens) for common OpenAI-compatible
// models, matched by case-insensitive substring of the model id. Providers'
// /v1/models endpoints don't report context length, so this table + the
// per-provider/per-model config overrides + RAYU_CONTEXT_TOKENS are the
// sources of truth. Order matters — more specific patterns first.
const KNOWN_MODEL_CONTEXT: Array<[RegExp, number]> = [
  // ~1M-context families — most specific patterns first
  [/nemotron.*ultra|nemotron-3-ultra/i, 1_048_576],           // NVIDIA nemotron-ultra (1M)
  [/gpt-4\.1/i, 1_048_576],                                   // OpenAI GPT-4.1 / 4.1-mini / 4.1-nano (1M)
  // Google Gemini 1.5/2/2.5/3.x — 1M-token context (pro & flash). Matches both
  // bare ids (gemini-3.5-flash) and the catalog's models/ prefix.
  [/gemini[-.]?(1\.5|2|2\.5|3)/i, 1_048_576],
  [/gemini/i, 1_048_576],
  [/deepseek[-/]?v4[-/]?(flash|pro)/i, 1_000_000],
  [/minimax/i, 1_000_000],
  // 256k
  [/kimi-k1|kimi.*long/i, 200_000],                           // Kimi K1.5 long-context
  [/kimi|moonshot/i, 131_072],                                 // Kimi K2 / Moonshot standard (128k)
  [/qwen[-.]?3[-.]?(coder|next)/i, 256_000],
  [/jamba/i, 256_000],
  [/step[-_.]?3\.7/i, 256_000],
  // 131k / 128k families
  [/deepseek-(chat|reasoner|v3|coder)/i, 131_072],
  [/deepseek-r1/i, 131_072],
  [/llama-3\.[1-3]|llama-3-70b|llama-4|nemotron/i, 131_072],
  [/qwen[-_.]?[23]|qwq/i, 131_072],
  [/gemma-[234]/i, 131_072],
  [/mixtral|mistral|ministral|codestral|devstral/i, 131_072],
  [/glm-[45]/i, 131_072],
  [/gpt-oss/i, 131_072],
  [/phi-[34]/i, 131_072],
  [/command-r|c4ai/i, 131_072],
  [/step-3/i, 65_536],
  // OpenAI (anchor o-series so e.g. gpt-4o don't false-match)
  [/gpt-5|(?:^|[/_-])(o1|o3|o4)(?:[.\-_]|$)/i, 128_000],
  [/gpt-4o/i, 128_000],
]

/**
 * Resolve the context window (tokens) for an OpenAI-compatible model.
 * Priority: RAYU_CONTEXT_TOKENS env → per-model config override →
 * per-provider config default → known-model table → null (caller defaults).
 * Records a diagnostic when it falls back so unknown models surface for tuning.
 */
export function getRayuModelContextWindow(model: string): number | null {
  const envOverride = parseInt(process.env.RAYU_CONTEXT_TOKENS || '', 10)
  if (!isNaN(envOverride) && envOverride > 0) return envOverride

  const p = getActiveProvider()
  // The known-model table + per-model overrides apply to any non-Anthropic
  // provider that routes through a translated chat client: OpenAI-compatible,
  // Gemini-on-Vertex ('vertex'), and Login-with-Gemini ('genai').
  if (
    !p ||
    (p.kind !== 'openai-compatible' &&
      p.kind !== 'vertex' &&
      p.kind !== 'genai')
  ) {
    return null
  }

  const perModel = p.modelContextWindows?.[model]
  if (perModel && perModel > 0) return perModel

  for (const [re, ctx] of KNOWN_MODEL_CONTEXT) {
    if (re.test(model)) return ctx
  }

  if (p.contextWindow && p.contextWindow > 0) return p.contextWindow

  reportIssue(
    'rayu_context.unknown_model',
    'context window unknown for model; using default — set provider.modelContextWindows or RAYU_CONTEXT_TOKENS',
    { provider: p.id, model },
    'low',
  )
  return null
}

/**
 * Fetch the model catalog from an OpenAI-compatible provider's `GET {baseURL}/models`
 * (NVIDIA/OpenAI/OpenRouter/local all expose this). Returns model ids, or [] on failure.
 * SECURITY: the api key is sent only to the user-configured baseURL; never logged.
 */
/**
 * Resolve the AWS region for a Bedrock provider: explicit awsRegion, else parse
 * from the bedrock-runtime base URL host, else the us-east-1 default.
 */
function bedrockRegionOf(p: RayuProvider): string {
  if (p.awsRegion) return p.awsRegion
  const m = p.baseURL?.match(/bedrock-runtime\.([a-z0-9-]+)\.amazonaws\.com/i)
  return m?.[1] ?? 'us-east-1'
}

type BedrockModelSummary = {
  modelId?: string
  inputModalities?: string[]
  outputModalities?: string[]
  inferenceTypesSupported?: string[]
  modelLifecycle?: { status?: string }
  // Bedrock reports, per model, which inference APIs it supports. The OpenAI
  // Chat Completions endpoint only serves models where openAiChatCompletions
  // is true (open-weight / OpenAI models); Anthropic & Nova are false.
  inferenceAPIsSupported?: { openAiChatCompletions?: boolean }
}

/**
 * Fetch the Bedrock model catalog from the control-plane endpoint
 * `GET https://bedrock.{region}.amazonaws.com/foundation-models`, authenticated
 * with the Bedrock API key (bearer token). Bedrock has no OpenAI-style /models
 * listing, so this control-plane call is the source of truth.
 *
 * Returns only models the region marks as `openAiChatCompletions: true` — the
 * authoritative signal that a model is invocable via Bedrock's OpenAI Chat
 * Completions endpoint (which Rayu's adapter uses). Anthropic Claude and Amazon
 * Nova report false here (they require the Anthropic Messages / Converse APIs),
 * so they are excluded to avoid 400/404 errors at chat time. These models are
 * invoked with their bare modelId (no inference-profile geo prefix).
 * SECURITY: the key is sent only to the AWS Bedrock control-plane host; never logged.
 */
async function fetchBedrockModels(p: RayuProvider): Promise<string[]> {
  if (!p.apiKey) return []
  const region = bedrockRegionOf(p)
  const url = `https://bedrock.${region}.amazonaws.com/foundation-models`
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${p.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      reportIssue('rayu_models.fetch_failed', 'bedrock foundation-models returned non-OK', {
        provider: p.id,
        status: res.status,
      })
      return []
    }
    const json = (await res.json()) as { modelSummaries?: BedrockModelSummary[] }
    const ids = new Set<string>()
    for (const m of json.modelSummaries ?? []) {
      const id = m.modelId
      if (!id) continue
      const status = m.modelLifecycle?.status
      if (status && status !== 'ACTIVE') continue
      // Authoritative: only list models the OpenAI Chat Completions endpoint serves.
      if (m.inferenceAPIsSupported?.openAiChatCompletions !== true) continue
      ids.add(id)
    }
    return [...ids].sort()
  } catch (e) {
    reportIssue('rayu_models.fetch_error', 'bedrock foundation-models request failed', {
      provider: p.id,
      error: e instanceof Error ? e.message : String(e),
    })
    return []
  }
}

type BedrockInferenceProfileSummary = {
  inferenceProfileId?: string
  status?: string
}

/**
 * Fetch the Claude model ids usable via Bedrock's Anthropic Messages API
 * (@anthropic-ai/bedrock-sdk, invoked with the bearer token). Combines:
 *  - cross-region inference profiles (GET /inference-profiles) whose id targets
 *    an Anthropic model — the invocable ids for newer Claude models
 *    (e.g. us.anthropic.claude-sonnet-4-5-20250929-v1:0); and
 *  - ON_DEMAND Anthropic foundation models (GET /foundation-models) invocable
 *    by their bare id (older Claude 3.x in some regions).
 * SECURITY: the key is sent only to the AWS Bedrock control-plane host; never logged.
 */
async function fetchBedrockAnthropicModels(p: RayuProvider): Promise<string[]> {
  if (!p.apiKey) return []
  const region = bedrockRegionOf(p)
  const headers = { Authorization: `Bearer ${p.apiKey}` }
  const ids = new Set<string>()
  // 1) Cross-region inference profiles (the invocable ids for newer Claude).
  try {
    const res = await fetch(
      `https://bedrock.${region}.amazonaws.com/inference-profiles?maxResults=1000`,
      { headers, signal: AbortSignal.timeout(15_000) },
    )
    if (res.ok) {
      const json = (await res.json()) as {
        inferenceProfileSummaries?: BedrockInferenceProfileSummary[]
      }
      for (const s of json.inferenceProfileSummaries ?? []) {
        const id = s.inferenceProfileId
        if (!id) continue
        if (s.status && s.status !== 'ACTIVE') continue
        // Anthropic Claude profiles only (this provider speaks the Messages API).
        if (!/anthropic|claude/i.test(id)) continue
        ids.add(id)
      }
    } else {
      reportIssue('rayu_models.fetch_failed', 'bedrock inference-profiles non-OK', {
        provider: p.id,
        status: res.status,
      })
    }
  } catch (e) {
    reportIssue('rayu_models.fetch_error', 'bedrock inference-profiles request failed', {
      provider: p.id,
      error: e instanceof Error ? e.message : String(e),
    })
  }
  // 2) ON_DEMAND Anthropic foundation models (bare ids, older Claude 3.x).
  try {
    const res = await fetch(
      `https://bedrock.${region}.amazonaws.com/foundation-models`,
      { headers, signal: AbortSignal.timeout(15_000) },
    )
    if (res.ok) {
      const json = (await res.json()) as { modelSummaries?: BedrockModelSummary[] }
      for (const m of json.modelSummaries ?? []) {
        const id = m.modelId
        if (!id || !/anthropic|claude/i.test(id)) continue
        const out = m.outputModalities ?? []
        const status = m.modelLifecycle?.status
        const inf = m.inferenceTypesSupported ?? []
        if (out.length && !out.includes('TEXT')) continue
        if (status && status !== 'ACTIVE') continue
        if (inf.includes('ON_DEMAND')) ids.add(id)
      }
    }
  } catch {
    // best-effort; profiles above are the primary source
  }
  return [...ids].sort()
}

type VertexPublisherModel = { name?: string }

/**
 * Curated list of current Gemini chat models on Vertex AI, newest first. Used
 * as a reliable fallback (and unioned with the live catalog) because the
 * publisher-models listing can come back empty/partial depending on project
 * permissions — without this the picker could be stuck on an old default.
 * Override with VERTEX_GEMINI_MODELS (comma-separated) to pin your own set.
 */
export const KNOWN_GEMINI_VERTEX_MODELS: string[] = [
  'gemini-3.5-flash',
  'gemini-3-flash',
  'gemini-3.1-pro-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
]

function curatedGeminiModels(): string[] {
  const env = process.env.VERTEX_GEMINI_MODELS
  if (env && env.trim()) {
    return env
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  }
  return KNOWN_GEMINI_VERTEX_MODELS
}

/**
 * Gemini models available via the Gemini Code Assist backend (Login with
 * Gemini). Code Assist uses DIFFERENT model ids than Vertex/AI-Studio — e.g.
 * `gemini-3-pro-preview` (not `gemini-3.5-flash`). Sending an unknown id 404s
 * ("Requested entity was not found"). Override with CODE_ASSIST_GEMINI_MODELS.
 */
export const KNOWN_GEMINI_CODE_ASSIST_MODELS: string[] = [
  'gemini-3.1-pro-preview',
  'gemini-3-pro-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
]

function curatedCodeAssistModels(): string[] {
  const env = process.env.CODE_ASSIST_GEMINI_MODELS
  if (env && env.trim()) {
    return env
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  }
  return KNOWN_GEMINI_CODE_ASSIST_MODELS
}

/**
 * Pick the preferred default Gemini model from a list: newest flash first
 * (3.5 → 3.x → any 3 → any flash), else the first entry.
 */
export function pickPreferredGeminiModel(models: string[]): string | undefined {
  const prefs = [
    /^gemini-3\.5-flash/i,
    /^gemini-3(\.\d+)?-flash/i,
    /^gemini-3.*flash/i,
    /^gemini-3/i,
    /flash/i,
  ]
  for (const re of prefs) {
    const hit = models.find(m => re.test(m))
    if (hit) return hit
  }
  return models[0]
}

/**
 * Parse the Vertex publisher-models response into bare Gemini chat model ids.
 * Names look like `publishers/google/models/gemini-2.5-flash`; we keep only
 * Gemini chat models (excluding imagen/veo/embedding/vision-only entries).
 * Exported for unit testing the parser without a live endpoint.
 */
export function parseVertexGeminiModels(json: unknown): string[] {
  const models =
    (json as { publisherModels?: VertexPublisherModel[] })?.publisherModels ?? []
  const ids = new Set<string>()
  for (const m of models) {
    const name = m?.name
    if (!name) continue
    const id = name.split('/').pop() ?? ''
    // Gemini chat models only — skip imagen/veo/embedding/aqa/etc.
    if (!/^gemini/i.test(id)) continue
    if (/embedding|embed|imagen|veo|vision-only|aqa/i.test(id)) continue
    // Skip image/audio-specialized previews that aren't general chat models.
    if (/-image|-tts|-audio|-live/i.test(id)) continue
    ids.add(id)
  }
  return [...ids].sort()
}

/**
 * Merge live + curated Gemini model ids, newest-ish first. Curated models lead
 * so current releases (Gemini 3.x) are always offered even when the live
 * listing is empty or lagging; any extra live models are appended.
 */
export function mergeGeminiModels(live: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of [...curatedGeminiModels(), ...live]) {
    if (!seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

/**
 * List Gemini models available on Vertex AI for the provider's region via the
 * publisher catalog `GET …/publishers/google/models`, authenticated with a
 * Google Cloud OAuth bearer token. Always unions with the curated current
 * model set so newer Gemini releases are offered even if listing is empty.
 * SECURITY: the bearer token is sent only to the Vertex host; never logged.
 */
async function fetchVertexGeminiModels(p: RayuProvider): Promise<string[]> {
  const region = p.gcpRegion || 'global'
  try {
    const { getVertexAccessToken } = await import(
      '../services/api/gemini/vertexAuth.js'
    )
    const { vertexHost } = await import('./rayuProviders.js')
    const token = await getVertexAccessToken()
    const url = `https://${vertexHost(region)}/v1beta1/publishers/google/models?pageSize=200`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      reportIssue('rayu_models.fetch_failed', 'vertex publisher models non-OK', {
        provider: p.id,
        status: res.status,
      })
      return mergeGeminiModels([])
    }
    return mergeGeminiModels(parseVertexGeminiModels(await res.json()))
  } catch (e) {
    reportIssue('rayu_models.fetch_error', 'vertex publisher models request failed', {
      provider: p.id,
      error: e instanceof Error ? e.message : String(e),
    })
    return mergeGeminiModels([])
  }
}

/**
 * Models for the Login-with-Gemini (Code Assist) provider. Code Assist exposes
 * no public model-listing endpoint, so we offer the curated current Gemini set.
 */
async function fetchGenAIGeminiModels(_p: RayuProvider): Promise<string[]> {
  return curatedCodeAssistModels()
}

export async function fetchProviderModels(p: RayuProvider): Promise<string[]> {
  // Bedrock exposes no OpenAI-style /models endpoint; list via its control plane.
  if (p.kind === 'bedrock') {
    return p.bedrockApi === 'anthropic'
      ? fetchBedrockAnthropicModels(p)
      : fetchBedrockModels(p)
  }
  // Gemini on Vertex AI: list Gemini models from the publisher catalog,
  // authenticated with a Google Cloud OAuth bearer token.
  if (p.kind === 'vertex') {
    return fetchVertexGeminiModels(p)
  }
  // Login-with-Gemini: list via the @google/genai SDK (OAuth), filter to chat.
  if (p.kind === 'genai') {
    return fetchGenAIGeminiModels(p)
  }
  if (p.kind !== 'openai-compatible' || !p.baseURL) return []
  const url = p.baseURL.replace(/\/+$/, '') + '/models'
  try {
    const res = await fetch(url, {
      headers: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {},
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      reportIssue('rayu_models.fetch_failed', 'provider /models returned non-OK', {
        provider: p.id,
        status: res.status,
      })
      return []
    }
    const json = (await res.json()) as { data?: Array<{ id?: string }> }
    return (json.data ?? [])
      .map(m => m.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .sort()
  } catch (e) {
    reportIssue('rayu_models.fetch_error', 'provider /models request failed', {
      provider: p.id,
      error: e instanceof Error ? e.message : String(e),
    })
    return []
  }
}

/**
 * Fetch + cache the active provider's model list (persisted to config so the
 * sync /model picker can read it). No-op for anthropic/no provider. Returns the
 * fetched ids (empty on failure — existing cache is preserved).
 */
export async function refreshActiveProviderModels(): Promise<string[]> {
  const p = getActiveProvider()
  if (
    !p ||
    (p.kind !== 'openai-compatible' &&
      p.kind !== 'bedrock' &&
      p.kind !== 'vertex' &&
      p.kind !== 'genai')
  )
    return []
  const models = await fetchProviderModels(p)
  if (models.length) {
    const cfg = loadRayuConfig()
    const cur = cfg.providers.find(x => x.id === p.id)
    if (cur) {
      cur.fetchedModels = models
      saveRayuConfig(cfg)
    }
  }
  return models
}

/**
 * Fetch + cache model catalogs for ALL openai-compatible providers that have
 * an empty fetchedModels cache. This ensures the /model picker shows full
 * catalogs across all providers, not just the active one.
 * Fire-and-forget; providers that fail silently keep their existing cache.
 */
export async function refreshAllProviderModels(): Promise<void> {
  const cfg = loadRayuConfig()
  let dirty = false
  const promises = cfg.providers
    .filter(
      p =>
        // Vertex/genai have no stored baseURL (computed); the others need one.
        (p.kind === 'vertex' ||
          p.kind === 'genai' ||
          ((p.kind === 'openai-compatible' || p.kind === 'bedrock') &&
            p.baseURL)) &&
        !(p.fetchedModels?.length),
    )
    .map(async p => {
      const models = await fetchProviderModels(p)
      if (models.length) {
        const cur = cfg.providers.find(x => x.id === p.id)
        if (cur) {
          cur.fetchedModels = models
          dirty = true
        }
      }
    })
  await Promise.allSettled(promises)
  if (dirty) saveRayuConfig(cfg)
}

/** Reset the in-memory cache (tests). */
export function _resetRayuConfigCache(): void {
  cache = null
}

/** Separator encoding provider+model in a single picker value. */
export const RAYU_MODEL_SEP = '\u0000'

/**
 * Encode a provider id + model id into a single string carried as the request
 * "model". Used to route a subagent request to a DIFFERENT provider than the
 * active one WITHOUT global state or AsyncLocalStorage (which is unreliable
 * across async generators on Bun). The prefix is decoded at client construction
 * (to pick the provider) and stripped before the model reaches the wire.
 */
export function encodeModelWithProvider(providerId: string, model: string): string {
  return `${providerId}${RAYU_MODEL_SEP}${model}`
}

/**
 * Decode a possibly provider-prefixed model string. Returns the bare model and,
 * when present, the providerId. Plain model strings (no separator) pass through
 * unchanged with providerId undefined.
 */
export function decodeModelProvider(model: string): {
  providerId?: string
  model: string
} {
  const idx = model.indexOf(RAYU_MODEL_SEP)
  if (idx === -1) return { model }
  return {
    providerId: model.slice(0, idx),
    model: model.slice(idx + RAYU_MODEL_SEP.length),
  }
}

export type RayuModelChoice = {
  /** Encoded value: `${providerId}\u0000${model}`. */
  value: string
  providerId: string
  model: string
}

/**
 * Aggregate selectable models across ALL configured providers,
 * so the model picker can search across every connected provider at once.
 * Active provider's models come first.
 *
 * For OpenAI-compatible providers: uses the live-fetched catalog + pinned models.
 * For Bedrock providers: uses the hardcoded ALL_MODEL_CONFIGS bedrock IDs.
 */
export function getAllProviderModelOptions(): RayuModelChoice[] {
  const cfg = loadRayuConfig()
  const active = getActiveProvider()?.id
  const out: RayuModelChoice[] = []
  const seen = new Set<string>()

  // Sort: active provider first, then others
  const sorted = [...cfg.providers].sort((a, b) =>
    a.id === active ? -1 : b.id === active ? 1 : 0,
  )

  for (const p of sorted) {
    if (p.kind === 'anthropic') continue

    // Collect model ids for any non-anthropic provider kind (openai-compatible,
    // bedrock, vertex, etc.). Priority: fetchedModels → pinned models → defaultModel.
    const ids = new Set<string>()
    for (const m of p.fetchedModels ?? []) ids.add(m)
    for (const m of p.models ?? []) ids.add(m)
    if (p.defaultModel) ids.add(p.defaultModel)

    for (const model of ids) {
      const value = `${p.id}${RAYU_MODEL_SEP}${model}`
      if (seen.has(value)) continue
      seen.add(value)
      out.push({ value, providerId: p.id, model })
    }
  }

  return out
}
