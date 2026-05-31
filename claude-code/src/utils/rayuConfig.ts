// Rayu provider configuration store. Persists user-supplied providers
// (id, apiKey, baseURL, default model) to ~/.rayu/providers.json.
//
// SECURITY: API keys are secrets. They are written to a 0600 file and are
// never logged or echoed; callers reference providers by id, not by key value.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { reportBug, reportIssue, reportVulnerability } from './rayuDiagnostics.js'

export type ProviderKind = 'anthropic' | 'openai-compatible'

export type RayuProvider = {
  /** Stable id, e.g. 'anthropic', 'nvidia', 'openai', 'openrouter', 'local'. */
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
}

export type RayuConfig = {
  /** id of the currently active provider. */
  activeProvider?: string
  providers: RayuProvider[]
}

const FILE_NAME = 'providers.json'

function configPath(): string {
  return join(getClaudeConfigHomeDir(), FILE_NAME)
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
  const dir = getClaudeConfigHomeDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  // 0600: secrets must not be world/group readable.
  writeFileSync(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 })
  cache = config
}

export function getActiveProvider(): RayuProvider | undefined {
  const cfg = loadRayuConfig()
  return (
    cfg.providers.find(p => p.id === cfg.activeProvider) ?? cfg.providers[0]
  )
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

/** True when at least one provider has credentials configured. */
export function hasConfiguredProvider(): boolean {
  return loadRayuConfig().providers.some(p => !!p.apiKey || p.kind === 'openai-compatible')
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
 * Model options for the active OpenAI-compatible provider, for the /model
 * picker. Returns the provider's listed models (default model first), or just
 * the default model. Empty for anthropic/no provider.
 */
export function getActiveProviderModelOptions(): Array<{
  value: string
  label: string
  description: string
}> {
  const p = getActiveProvider()
  if (!p || p.kind !== 'openai-compatible') return []
  const ids = new Set<string>()
  if (p.defaultModel) ids.add(p.defaultModel)
  for (const m of p.models ?? []) ids.add(m) // user-pinned
  for (const m of p.fetchedModels ?? []) ids.add(m) // live from /v1/models
  return [...ids].map(id => ({
    value: id,
    label: id,
    description: `${p.id} · ${id}`,
  }))
}

// Best-effort known context windows (tokens) for common OpenAI-compatible
// models, matched by case-insensitive substring of the model id. Providers'
// /v1/models endpoints don't report context length, so this table + the
// per-provider/per-model config overrides + RAYU_CONTEXT_TOKENS are the
// sources of truth. Order matters — more specific patterns first.
const KNOWN_MODEL_CONTEXT: Array<[RegExp, number]> = [
  [/deepseek[-/]?v4[-/]?(flash|pro)/i, 1_000_000],
  [/deepseek-(chat|reasoner|v3|coder)/i, 131_072],
  [/llama-3\.[13]|llama-3-70b|llama-4|nemotron/i, 131_072],
  [/kimi|moonshot/i, 256_000],
  [/qwen3|qwen-3|qwq/i, 131_072],
  [/gpt-4o|gpt-4\.1|o3|o4/i, 128_000],
  [/gemma-[234]/i, 131_072],
  [/mixtral|mistral/i, 131_072],
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
  if (!p || p.kind !== 'openai-compatible') return null

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
export async function fetchProviderModels(p: RayuProvider): Promise<string[]> {
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
  if (!p || p.kind !== 'openai-compatible') return []
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

/** Reset the in-memory cache (tests). */
export function _resetRayuConfigCache(): void {
  cache = null
}

/** Separator encoding provider+model in a single picker value. */
export const RAYU_MODEL_SEP = '\u0000'

export type RayuModelChoice = {
  /** Encoded value: `${providerId}\u0000${model}`. */
  value: string
  providerId: string
  model: string
}

/**
 * Aggregate selectable models across ALL configured OpenAI-compatible providers,
 * so the model picker can search across every connected provider at once.
 * Active provider's models come first.
 */
export function getAllProviderModelOptions(): RayuModelChoice[] {
  const cfg = loadRayuConfig()
  const active = getActiveProvider()?.id
  const providers = cfg.providers
    .filter(p => p.kind === 'openai-compatible')
    .sort((a, b) => (a.id === active ? -1 : b.id === active ? 1 : 0))
  const out: RayuModelChoice[] = []
  const seen = new Set<string>()
  for (const p of providers) {
    const ids = new Set<string>()
    if (p.defaultModel) ids.add(p.defaultModel)
    for (const m of p.models ?? []) ids.add(m)
    for (const m of p.fetchedModels ?? []) ids.add(m)
    for (const model of ids) {
      const value = `${p.id}${RAYU_MODEL_SEP}${model}`
      if (seen.has(value)) continue
      seen.add(value)
      out.push({ value, providerId: p.id, model })
    }
  }
  return out
}
