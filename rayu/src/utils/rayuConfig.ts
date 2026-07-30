// Rayu provider configuration store. Persists user-supplied providers
// (id, apiKey, baseURL, default model) to ~/.rayu/providers.json.
//
// SECURITY: API keys are secrets. They are written to a 0600 file and are
// never logged or echoed; callers reference providers by id, not by key value.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getRayuConfigHomeDir } from './envUtils.js'
import { clearContextPrepCache } from './contextPrepCache.js'
import { CURATED_PROVIDER_MODELS } from './curatedProviderModels.js'
import { reportBug, reportIssue, reportVulnerability } from './rayuDiagnostics.js'

export type ProviderKind = 'anthropic' | 'anthropic-compatible' | 'openai-compatible' | 'bedrock' | 'azure' | 'vertex' | 'genai' | 'kiro' | 'copilot' | 'rayu-hosted'
export type ProviderFeatureMode = 'auto' | 'enabled' | 'disabled'

/**
 * The wire protocols Rayu speaks. A provider KIND says who you are talking to;
 * a WIRE FORMAT says which request/response shape goes over the socket. The two
 * are deliberately separate because one provider entry can serve several formats
 * (e.g. a single Bedrock provider: Claude models over Anthropic Messages,
 * open-weight models over OpenAI Chat Completions).
 *
 * `anthropic-messages` is not merely one of the formats — it is the app's
 * internal IR. claude.ts builds an Anthropic Messages (beta) request and every
 * adapter presents `beta.messages.create(...).withResponse()`, translating
 * outward from that shape.
 *
 * Defined here (next to ProviderKind) rather than in services/api so config
 * types stay free of any dependency on the request layer.
 */
export type WireFormat =
  | 'anthropic-messages'
  | 'openai-chat'
  | 'openai-responses'
  | 'genai'
  | 'codewhisperer'

export type RayuProvider = {
  /** Stable id, e.g. 'anthropic', 'nvidia', 'openai', 'openrouter', 'local', 'bedrock'. */
  id: string
  kind: ProviderKind
  /**
   * Explicit wire-format override, highest precedence in resolveWireFormat().
   * Set for user-defined custom providers, where the format is chosen in the
   * /connect wizard rather than inferred from the kind + model id. Leave unset
   * for built-in providers so they keep their per-kind / per-model rules.
   */
  wireFormat?: WireFormat
  apiKey?: string
  /**
   * Multiple API keys for openai-compatible multi-key providers (NVIDIA /
   * OpenRouter). When present, the request path rotates to the next key on a
   * rate-limit/quota error (429/402/401/403). `apiKey` is kept in sync as
   * apiKeys[0] so every single-key reader (image/video gen, fastMode, env
   * migration) keeps working unchanged. Gated to Basic-plan users — see
   * isMultiApiKeyAllowed().
   */
  apiKeys?: string[]
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
  /**
   * Per-model DISPLAY NAME, keyed by model id. Populated for rayu-hosted from
   * /me/entitlements (the name the Rayu admin typed), so the picker can show
   * "DeepSeek V4 Pro" next to the id the request actually carries. Nothing about
   * the hosted catalog is hardcoded in the CLI: a rename in the dashboard lands
   * here on the next entitlements refresh. A model with no name is simply absent
   * from the map, and the picker then shows the id alone.
   */
  modelLabels?: Record<string, string>
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
   * @deprecated LEGACY Bedrock API-surface discriminator.
   *
   * Bedrock is now ONE provider whose wire format is resolved per MODEL
   * (resolveWireFormat: Claude → Anthropic Messages on the bedrock-runtime
   * invoke endpoints; everything Bedrock serves over OpenAI Chat Completions →
   * the bedrock-mantle endpoint). The Converse surface was retired.
   *
   * This field is READ ONLY for backwards compatibility, so providers saved by
   * older versions keep behaving identically until
   * migrateBedrockToUnifiedProvider() drops it at startup. Never write it.
   */
  bedrockApi?: 'openai' | 'anthropic' | 'converse'
  /** AWS Access Key ID. SECURITY: stored in 0600 config file. */
  awsAccessKeyId?: string
  /** AWS Secret Access Key. SECURITY: stored in 0600 config file. */
  awsSecretAccessKey?: string
  /** AWS region for Bedrock API calls (default: us-east-1). */
  awsRegion?: string
  // --- Microsoft Azure / Foundry fields (kind: 'azure') ---
  /**
   * Azure resource name ('my-resource') or a full endpoint URL. Both surfaces are
   * derived from it: `{origin}/anthropic` for Claude and `{origin}/openai/v1` for
   * Azure OpenAI. See services/api/azureFoundry.ts.
   */
  azureResource?: string
  /** `api-version` for the Azure OpenAI surface (default: 'preview'). */
  azureApiVersion?: string
  // --- Google Vertex AI fields (kind: 'vertex') ---
  /** GCP project id for Vertex AI requests. */
  gcpProject?: string
  /** GCP region (location) for Vertex AI requests (default: us-central1). */
  gcpRegion?: string
  // --- Kiro fields (kind: 'kiro') ---
  /**
   * How a Kiro provider authenticates to the AWS CodeWhisperer backend:
   * - 'apikey': the ksk_ key (stored in apiKey) is sent as a bearer token plus
   *   a `TokenType: API_KEY` header.
   * - 'oauth': read/refresh the token written by `kiro-cli login` at
   *   ~/.local/share/kiro-cli/data.sqlite3 (no apiKey is stored).
   */
  kiroAuthType?: 'apikey' | 'oauth'
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
   * Per-agent overrides keyed by agent type (e.g. 'backend'). Takes
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
  /**
   * Default model id for the WebFetch tool's page-summarization step, chosen
   * via /webfetch_model. When unset, WebFetch uses the active provider's
   * instant/small-fast model (see getWebFetchModel / getSmallFastModel) — i.e.
   * the user's own configured model, never a hardcoded Anthropic model.
   */
  webFetchModel?: string
  /**
   * Opt-in project profile name for the specialist swarm (e.g. 'cambodia').
   * When set, the matching locale/stack fragments are injected into PA/DB/MOB.
   * Unset → no locale bias (the 'default' profile). See built-in/profiles.ts.
   */
  projectProfile?: string
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
 * The per-agent subagent override ONLY (ignores the global default). Used by
 * model resolution to decide whether an explicit /model_subagent or
 * /collaborator_model selection should override an agent's hardcoded model
 * (including 'inherit'), while leaving fork/inherit agents untouched when the
 * user hasn't configured that specific agent type.
 */
export function getPerAgentSubagentSelection(
  agentType?: string,
): { providerId: string; model: string } | undefined {
  if (!agentType) return undefined
  const cfg = loadRayuConfig()
  const perAgent = cfg.subagentByAgent?.[agentType]
  if (perAgent?.providerId && perAgent?.model) {
    return { providerId: perAgent.providerId, model: perAgent.model }
  }
  return undefined
}

/**
 * Persist a subagent model selection (set via /model_subagent). With no
 * agentType, sets the GLOBAL default for all subagents. With an agentType
 * (e.g. 'backend'), sets a per-agent override. Does NOT change the active
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

/** User-chosen model for the WebFetch summarization step (or undefined). */
export function getWebFetchModelSelection(): string | undefined {
  return loadRayuConfig().webFetchModel || undefined
}

/** Persist the default WebFetch model (pass undefined to clear → default). */
export function setWebFetchModelSelection(model: string | undefined): void {
  const cfg = loadRayuConfig()
  if (model) cfg.webFetchModel = model
  else delete cfg.webFetchModel
  saveRayuConfig(cfg)
}

/** True when at least one provider has credentials configured. */
export function hasConfiguredProvider(): boolean {
  return loadRayuConfig().providers.some(
    p =>
      !!p.apiKey ||
      p.kind === 'openai-compatible' ||
      (p.kind === 'bedrock' && !!p.awsAccessKeyId) ||
      p.kind === 'kiro',
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
  // Prefer the explicit apiKey (kept in sync as apiKeys[0]); fall back to the
  // first stored multi-key so callers still resolve a key if only apiKeys is set.
  return p?.apiKey ?? p?.apiKeys?.find(k => !!k?.trim()) ?? null
}

/**
 * Resolve the ordered, de-duplicated list of non-empty API keys for a provider.
 * Prefers the multi-key `apiKeys` list; falls back to the single `apiKey`.
 * Returns [] when the provider has no key configured. This is the source of
 * truth the request path uses to build per-key clients for rate-limit rotation.
 */
export function getProviderApiKeys(p: RayuProvider | undefined): string[] {
  if (!p) return []
  const out: string[] = []
  const seen = new Set<string>()
  const push = (raw: string | undefined) => {
    const k = raw?.trim()
    if (k && !seen.has(k)) {
      seen.add(k)
      out.push(k)
    }
  }
  for (const k of p.apiKeys ?? []) push(k)
  push(p.apiKey)
  return out
}

/**
 * Persist the full API-key list for a provider (multi-key providers). Trims +
 * de-dupes, keeps `apiKey` in sync as keys[0] for single-key readers, and
 * removes both fields when the list is empty. Marks the provider active.
 * SECURITY: keys are secrets — written to the 0600 config file, never logged.
 */
export function setProviderApiKeys(
  providerId: string,
  keys: string[],
  setActive = true,
): void {
  const cfg = loadRayuConfig()
  const provider = cfg.providers.find(p => p.id === providerId)
  if (!provider) return
  const cleaned: string[] = []
  const seen = new Set<string>()
  for (const raw of keys) {
    const k = raw?.trim()
    if (k && !seen.has(k)) {
      seen.add(k)
      cleaned.push(k)
    }
  }
  if (cleaned.length > 0) {
    provider.apiKeys = cleaned
    provider.apiKey = cleaned[0]
  } else {
    delete provider.apiKeys
    delete provider.apiKey
  }
  if (setActive) cfg.activeProvider = providerId
  saveRayuConfig(cfg)
}

/**
 * Model options across ALL configured non-anthropic Rayu providers, for the
 * /model picker fallback path (keybinding shortcut). Active provider first,
 * then other providers. Any new provider kind (vertex, etc.) is included
 * automatically as long as kind !== 'anthropic'.
 *
 * Any new provider kind (vertex, etc.) is included automatically as long as
 * kind !== 'anthropic'.
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
  [/deepseek[-_/.]?v4/i, 1_000_000],                          // DeepSeek V4 — flash & pro (1M context)
  [/longcat/i, 1_000_000],                                    // LongCat 2.0 (Meituan, 1M context)
  [/minimax[-_.]?m3/i, 1_000_000],                            // MiniMax-M3 (1M agentic/long-context)
  [/glm-?5\.2/i, 1_000_000],                                  // GLM-5.2 (1M context — up from GLM-5.1's 200K)
  [/fugu/i, 1_000_000],                                       // Sakana AI Fugu / Fugu Ultra (1M)
  [/llama[-_.]?4/i, 1_000_000],                               // Meta Llama 4 (Scout/Maverick — 1M+ context)
  // 256k
  [/kimi-k1|kimi.*long/i, 200_000],                           // Kimi K1.5 long-context
  // Newer Kimi K2 releases — K2.5 / K2.6 / K2 Thinking / dated K2-<NNNN> (e.g.
  // K2-0905) — ship a 256k window. Match these BEFORE the generic Kimi rule
  // (first match wins); the original K2 (0711) stays on the 128k fallback below.
  [/kimi[-_.]?k2[-_.]?(thinking|\d{4}|[5-9])/i, 256_000],     // Kimi K2.5 / K2.6 / Thinking (256k)
  [/kimi[-_.\s]?cod(e|ing)|kimi[-_.]?k?2[.\-_]?7/i, 256_000], // Kimi Code 2.7 / Kimi coding models (256k)
  [/kimi|moonshot/i, 131_072],                                 // Kimi K2 (0711) / Moonshot standard (128k)
  [/qwen[-.]?3\.5/i, 256_000],                                // Qwen3.5 (Ollama Cloud 397b/122b — 256K)
  [/qwen[-.]?3[-.]?(coder|next)/i, 256_000],
  [/jamba/i, 256_000],
  [/step[-_.]?3\.7/i, 256_000],
  // Anthropic Claude served via Copilot / OpenRouter / etc. — 200k standard.
  [/claude/i, 200_000],
  [/minimax/i, 204_800],                                       // MiniMax-M2 / M2.x (204,800)
  // 131k / 128k families
  [/deepseek-(chat|reasoner|v3|coder)/i, 131_072],
  [/deepseek-r1/i, 131_072],
  [/llama-3\.[1-3]|llama-3-70b|nemotron/i, 131_072],
  [/qwen[-_.]?[23]|qwq/i, 131_072],
  [/gemma-[234]/i, 131_072],
  [/mixtral|mistral|ministral|codestral|devstral/i, 131_072],
  [/glm-(4\.[56]v|5v)/i, 65_536],                              // GLM vision models (GLM-4.5V / 4.6V / 5V — 64K, conservative)
  [/glm-4\.[67]|glm-5/i, 200_000],                             // GLM-4.6 / 4.7 / 5 / 5.1 / 5-turbo (200K context)
  [/glm-4/i, 131_072],                                         // GLM-4.5 / 4.5-Air / 4-32B (128K)
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
  // Kiro: per-model context from the Kiro catalog (opus-4.7/4.8 are 1M; sonnet/
  // haiku base are 200k). Per-model config overrides still win.
  if (p?.kind === 'kiro') {
    const perModel = p.modelContextWindows?.[model]
    if (perModel && perModel > 0) return perModel
    try {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { resolveKiroModel } =
        require('../services/api/kiro/kiroModels.js') as typeof import('../services/api/kiro/kiroModels.js')
      /* eslint-enable @typescript-eslint/no-require-imports */
      const ctx = resolveKiroModel(model).contextWindowSize
      if (ctx > 0) return ctx
    } catch {
      // fall through to default
    }
    return null
  }
  // The known-model table + per-model overrides apply to every other
  // non-Anthropic provider (OpenAI-compatible, Vertex, Login-with-Gemini,
  // Copilot, Bedrock, and any FUTURE provider kind), where the CLI is the only
  // thing that knows the model. Anthropic uses the SDK's own context handling;
  // Kiro is resolved above via its catalog; rayu-hosted is resolved below from
  // the SERVER catalog (never from this table).
  if (!p || p.kind === 'anthropic') {
    return null
  }
  // Rayu-HOSTED: the catalog is SERVER-DRIVEN, so the context window must be too.
  // The admin sets it per model in the dashboard; it arrives via
  // /me/entitlements and is synced into modelContextWindows by
  // syncRayuHostedProvider. We deliberately do NOT consult the built-in
  // KNOWN_MODEL_CONTEXT table here: a hosted model may be added or renamed at any
  // time, and matching an admin's model code against hardcoded patterns is how a
  // brand-new model silently inherits some other model's window. Unknown window →
  // null, and the caller applies its documented default.
  if (p.kind === 'rayu-hosted') {
    const perModel = p.modelContextWindows?.[model]
    if (perModel && perModel > 0) return perModel
    // Provider-level fallback is still honoured: it is explicit local config
    // (or an operator override), not a guess about the model.
    if (p.contextWindow && p.contextWindow > 0) return p.contextWindow
    reportIssue(
      'rayu_context.hosted_window_unset',
      'no admin-configured context window for this Rayu-hosted model; using the client default — set it in Admin → Providers → the model row',
      { provider: p.id, model },
      'low',
    )
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
 * from the base URL host (bedrock-mantle.{region}.api.aws or the legacy
 * bedrock-runtime.{region}.amazonaws.com), else the us-east-1 default.
 */
function bedrockRegionOf(p: RayuProvider): string {
  if (p.awsRegion) return p.awsRegion
  const m = p.baseURL?.match(
    /bedrock-mantle\.([a-z0-9-]+)\.api\.aws|bedrock-runtime\.([a-z0-9-]+)\.amazonaws\.com/i,
  )
  return m?.[1] ?? m?.[2] ?? 'us-east-1'
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


type BedrockInferenceProfileSummary = {
  inferenceProfileId?: string
  status?: string
}

/**
 * Sanitize a model id coming from a REMOTE catalog before it is persisted or
 * used.
 *
 * SECURITY: catalog responses are untrusted input. `encodeModelWithProvider`
 * joins a provider id and a model id with `\u0000`, so a model id containing
 * that separator (or other control characters) could spoof provider routing and
 * send a request to a different provider than the user selected. Ids are also
 * length-capped and restricted to the characters real ids actually use
 * (alphanumerics plus `. - _ : / @ +`), verified against live Bedrock, Vertex,
 * Copilot and OpenAI-compatible catalogs.
 */
export function sanitizeRemoteModelId(id: unknown): string | null {
  if (typeof id !== 'string') return null
  const trimmed = id.trim()
  if (!trimmed || trimmed.length > 512) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null
  if (!/^[A-Za-z0-9._:/@+-]+$/.test(trimmed)) return null
  return trimmed
}

/**
 * Fetch the FULL Bedrock catalog for one provider: every model the account can
 * invoke, across both wire formats.
 *
 * Each surface is listed from the endpoint that ACTUALLY serves it, because the
 * two disagree about model ids (verified live in us-east-1):
 *
 *  1. Claude → `GET {control plane}/inference-profiles`. Claude is only invocable
 *     through a cross-region inference profile: every ACTIVE `anthropic.*`
 *     foundation model reports `inferenceTypesSupported: ['INFERENCE_PROFILE']`
 *     and none is ON_DEMAND, so ids like
 *     `global.anthropic.claude-haiku-4-5-20251001-v1:0` are the invocable ones.
 *     These speak the Anthropic Messages API on bedrock-runtime.
 *
 *  2. Everything else → `GET {mantle baseURL}/models`, the OpenAI-compatible
 *     listing of the endpoint that will serve the request. The control plane's
 *     `openAiChatCompletions` flag is NOT usable as the id source: of its 34
 *     flagged models only 27 ids match mantle exactly — the control plane returns
 *     version-suffixed ids (`openai.gpt-oss-120b-1:0`, `qwen.qwen3-32b-v1:0`) and
 *     a different vendor prefix (`moonshot.` vs mantle's `moonshotai.`), all of
 *     which 404 on the chat endpoint. Mantle also serves 22 models the control
 *     plane does not flag at all (gemma-4, gpt-5.4, deepseek.v3.1).
 *     Mantle DOES list `anthropic.*` ids, but invoking one returns
 *     400 "does not support the '/v1/chat/completions' API", so they are excluded
 *     here — Claude comes from step 1 in its invocable form.
 *
 * ON_DEMAND `anthropic.*` foundation models are also included when a region
 * offers them (older Claude 3.x), since those are invocable by bare id.
 *
 * resolveWireFormat() then picks the right format per model, so ONE Bedrock
 * provider serves its whole catalog.
 *
 * Models that support neither surface (Amazon Nova, and Mistral/Cohere/Llama in
 * regions without a mantle endpoint) are intentionally NOT listed: they were only
 * reachable through the Converse API, which this migration removed.
 *
 * SECURITY: the key is sent only to the AWS Bedrock hosts; never logged.
 */
async function fetchBedrockModels(p: RayuProvider): Promise<string[]> {
  if (!p.apiKey) return []
  const region = bedrockRegionOf(p)
  const headers = { Authorization: `Bearer ${p.apiKey}` }
  const ids = new Set<string>()

  const add = (raw: unknown) => {
    const id = sanitizeRemoteModelId(raw)
    if (id) ids.add(id)
  }

  // 1) Cross-region inference profiles — the invocable ids for Claude.
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
        // Anthropic Claude profiles (served over Anthropic Messages).
        if (!/anthropic|claude/i.test(id)) continue
        add(id)
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

  // 2) The mantle OpenAI-compatible listing — authoritative for the ids that
  //    endpoint accepts. rayuProviders is imported lazily to avoid a cycle.
  const { bedrockBaseURL } = await import('./rayuProviders.js')
  const mantleBase = (p.baseURL || bedrockBaseURL(region)).replace(/\/+$/, '')
  try {
    const res = await fetch(`${mantleBase}/models`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    })
    if (res.ok) {
      const json = (await res.json()) as { data?: Array<{ id?: string }> }
      for (const m of json.data ?? []) {
        const id = m.id
        if (!id) continue
        // Listed but not servable here: mantle rejects Claude with a 400.
        if (/^anthropic\.|claude/i.test(id)) continue
        add(id)
      }
    } else {
      reportIssue('rayu_models.fetch_failed', 'bedrock mantle /models non-OK', {
        provider: p.id,
        status: res.status,
      })
    }
  } catch (e) {
    reportIssue('rayu_models.fetch_error', 'bedrock mantle /models request failed', {
      provider: p.id,
      error: e instanceof Error ? e.message : String(e),
    })
  }

  // 3) ON_DEMAND Anthropic foundation models (bare ids, older Claude 3.x in some
  //    regions) — invocable directly, without an inference profile.
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
        if (m.modelLifecycle?.status && m.modelLifecycle.status !== 'ACTIVE') continue
        const out = m.outputModalities ?? []
        if (out.length && !out.includes('TEXT')) continue
        if ((m.inferenceTypesSupported ?? []).includes('ON_DEMAND')) add(id)
      }
    }
  } catch {
    // Best-effort: the inference profiles above are the primary Claude source.
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
  // 2.5 family is available across all Vertex regions — safe fallback leaders.
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  // 3.x are valid Vertex publisher ids but only in some regions (global /
  // us-central1) — included so they appear when the live catalog is unavailable.
  'gemini-3-pro-preview',
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
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
 * Preferred default model for the Login-with-Gemini (Code Assist) provider.
 * Prefers the cheapest-per-request flash model (gemini-2.5-flash): Code Assist
 * consumer plans meter by request complexity, so pro/preview models burn the
 * quota far faster. Users can still pick pro/preview models via /model.
 */
export function pickPreferredCodeAssistModel(models: string[]): string | undefined {
  const prefs = [/^gemini-2\.5-flash$/i, /flash/i]
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
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    // The publisher-models LIST endpoint requires a quota/billing project (the
    // chat endpoint does not). Without this header it 403s and we'd fall back to
    // the curated list (which may carry ids the region doesn't serve → 404s).
    if (p.gcpProject) headers['x-goog-user-project'] = p.gcpProject
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      reportIssue('rayu_models.fetch_failed', 'vertex publisher models non-OK', {
        provider: p.id,
        status: res.status,
      })
      return mergeGeminiModels([])
    }
    // Return ONLY the models this project+region actually serves. Do NOT merge
    // the curated list here — curated ids (e.g. Gemini 3.x) that the region
    // doesn't serve would 404 at chat time. Curated is a last resort only when
    // the live listing yields nothing.
    const live = parseVertexGeminiModels(await res.json())
    return live.length ? live : mergeGeminiModels([])
  } catch (e) {
    reportIssue('rayu_models.fetch_error', 'vertex publisher models request failed', {
      provider: p.id,
      error: e instanceof Error ? e.message : String(e),
    })
    return mergeGeminiModels([])
  }
}

/**
 * Full Vertex catalog for a provider: Gemini + Claude + MaaS.
 *
 * Gemini comes from the live publisher listing (see fetchVertexGeminiModels).
 * Claude and the MaaS models are CURATED: Vertex's publisher-models listing
 * covers Google's own publisher only, and there is no reliable listing for the
 * `anthropic` publisher or the openapi MaaS endpoint — so inventing one would be
 * guesswork. Both curated sets are env-overridable (VERTEX_CLAUDE_MODELS /
 * VERTEX_MAAS_MODELS). resolveWireFormat() routes each id to its own format.
 */
async function fetchVertexModels(p: RayuProvider): Promise<string[]> {
  const gemini = await fetchVertexGeminiModels(p)
  const { curatedVertexClaudeModels, curatedVertexMaasModels } = await import(
    '../services/api/gemini/vertexAnthropic.js'
  )
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of [
    ...gemini,
    ...curatedVertexClaudeModels(),
    ...curatedVertexMaasModels(),
  ]) {
    const id = sanitizeRemoteModelId(raw)
    if (id && !seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

/**
 * Models for the Login-with-Gemini (Code Assist) provider. Code Assist exposes
 * no public model-listing endpoint, so we offer the curated current Gemini set.
 */
async function fetchGenAIGeminiModels(_p: RayuProvider): Promise<string[]> {
  return curatedCodeAssistModels()
}

/**
 * Fetch the deployments/models an Azure resource exposes.
 *
 * Azure has two documented listings and which one a resource answers depends on
 * whether it is on the v1 API, so both are tried in order (see
 * services/api/azureFoundry.ts). Deployment NAMES are what must be sent as the
 * model, so the listing's `id` is used.
 *
 * The returned ids span both wire formats — resolveWireFormat() routes each one
 * (Claude → Anthropic Messages, everything else → Azure OpenAI Responses).
 *
 * NOT live-verified: no Azure credentials were available, so the response shapes
 * come from the Microsoft REST reference rather than an observed response.
 * SECURITY: the key is sent only to the validated Azure origin; never logged.
 */
async function fetchAzureModels(p: RayuProvider): Promise<string[]> {
  const endpoint = p.azureResource || p.baseURL || ''
  if (!p.apiKey || !endpoint) return []
  const { azureModelListURLs, parseAzureModelList, validateAzureEndpoint } =
    await import('../services/api/azureFoundry.js')
  const valid = validateAzureEndpoint(endpoint)
  if (!valid.ok) {
    reportIssue('rayu_models.fetch_failed', 'azure endpoint rejected', {
      provider: p.id,
      reason: valid.reason,
    })
    return []
  }
  const ids = new Set<string>()
  for (const url of azureModelListURLs(endpoint, p.azureApiVersion)) {
    try {
      const res = await fetch(url, {
        headers: { 'api-key': p.apiKey },
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) continue
      for (const raw of parseAzureModelList(await res.json())) {
        const id = sanitizeRemoteModelId(raw)
        if (id) ids.add(id)
      }
      if (ids.size) break
    } catch (e) {
      reportIssue('rayu_models.fetch_error', 'azure model listing failed', {
        provider: p.id,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
  return [...ids].sort()
}

export async function fetchProviderModels(p: RayuProvider): Promise<string[]> {
  // Bedrock exposes no OpenAI-style /models endpoint; list via its control plane.
  // ONE unified catalog spanning both wire formats (Claude inference profiles +
  // the OpenAI-Chat-capable foundation models).
  if (p.kind === 'bedrock') {
    return fetchBedrockModels(p)
  }
  // Azure: deployments span both wire formats (Claude + Azure OpenAI).
  if (p.kind === 'azure') {
    return fetchAzureModels(p)
  }
  // Vertex AI: ONE provider spanning three formats — Gemini from the live
  // publisher catalog, plus the curated Claude + MaaS sets.
  if (p.kind === 'vertex') {
    return fetchVertexModels(p)
  }
  // Login-with-Gemini: list via the @google/genai SDK (OAuth), filter to chat.
  if (p.kind === 'genai') {
    return fetchGenAIGeminiModels(p)
  }
  // Kiro: curated Claude model list (no live /models endpoint). Lazy import so
  // kiro modules stay out of startup.
  if (p.kind === 'kiro') {
    const { listKiroModels } = await import('../services/api/kiro/kiroModels.js')
    return listKiroModels()
  }
  // GitHub Copilot: list models from api.githubcopilot.com/models with a fresh
  // Copilot token derived from the stored GitHub OAuth token (provider.apiKey).
  if (p.kind === 'copilot') {
    const { fetchCopilotModels } = await import('../services/api/copilot/copilotAuth.js')
    return fetchCopilotModels(p.apiKey)
  }
  // Ollama Cloud is kind:'anthropic-compatible' for CHAT, but lists the account's
  // models via Ollama's own endpoints (GET /v1/models, /api/tags fallback) with
  // the user's Bearer key. Context windows are fetched separately at connect time
  // (fetchOllamaCloudModelContexts) with the known-model table as the fallback.
  if (p.id === 'ollama-cloud') {
    const { fetchOllamaCloudModels } = await import('../services/api/ollamaCloud.js')
    return fetchOllamaCloudModels(p.apiKey, p.baseURL)
  }
  if (p.kind !== 'openai-compatible' || !p.baseURL) return []
  const curated = CURATED_PROVIDER_MODELS[p.id] ?? []
  const url = p.baseURL.replace(/\/+$/, '') + '/models'
  let fetched: string[] = []
  try {
    const res = await fetch(url, {
      headers: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {},
      signal: AbortSignal.timeout(15_000),
    })
    if (res.ok) {
      const json = (await res.json()) as { data?: Array<{ id?: string }> }
      fetched = (json.data ?? [])
        .map(m => m.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    } else {
      reportIssue('rayu_models.fetch_failed', 'provider /models returned non-OK', {
        provider: p.id,
        status: res.status,
      })
    }
  } catch (e) {
    reportIssue('rayu_models.fetch_error', 'provider /models request failed', {
      provider: p.id,
      error: e instanceof Error ? e.message : String(e),
    })
  }
  // Some OpenAI-compatible providers (e.g. Doubleword — batch-first) return an
  // EMPTY /models list, so the picker would only show the preset default. Merge
  // in a curated catalog when one exists for this provider: union, deduped + sorted.
  if (curated.length) {
    return [...new Set([...fetched, ...curated])].sort()
  }
  return fetched.sort()
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
      p.kind !== 'azure' &&
      p.kind !== 'vertex' &&
      p.kind !== 'genai' &&
      p.kind !== 'kiro' &&
      p.kind !== 'copilot' &&
      p.kind !== 'anthropic-compatible')
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
        // Vertex/genai/copilot/kiro have no stored baseURL (computed);
        // the others need one.
        (p.kind === 'vertex' ||
          p.kind === 'genai' ||
          p.kind === 'copilot' ||
          p.kind === 'kiro' ||
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
  /**
   * Admin-configured display name for this model, when the provider has one
   * (rayu-hosted gets these from /me/entitlements). Absent for providers whose
   * models are just ids, which is every BYO provider.
   */
  label?: string
  /** Admin-configured context window in tokens, when known. */
  contextWindow?: number
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
      // Name + window are carried through when the provider knows them, so the
      // picker never has to look up a per-provider table of its own.
      const label = p.modelLabels?.[model]
      const contextWindow = p.modelContextWindows?.[model]
      out.push({
        value,
        providerId: p.id,
        model,
        ...(label ? { label } : {}),
        ...(contextWindow && contextWindow > 0 ? { contextWindow } : {}),
      })
    }
  }

  // Pin the entire rayu-hosted provider's models to the very top of the picker
  // so the hosted models are always the first choices, regardless of which
  // provider is active. (Only has an effect when rayu-hosted is configured.)
  // The id 'rayu-hosted' (RAYU_HOSTED_PROVIDER_ID) is inlined to avoid a
  // rayuProviders↔rayuConfig import cycle. Stable sort preserves the existing
  // order within the rayu-hosted group and among all the other entries.
  out.sort((a, b) => {
    const ra = a.providerId === 'rayu-hosted' ? 0 : 1
    const rb = b.providerId === 'rayu-hosted' ? 0 : 1
    return ra - rb
  })

  return out
}
