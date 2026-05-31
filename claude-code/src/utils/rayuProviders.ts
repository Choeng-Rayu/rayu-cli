// Shared registry of built-in provider presets for Rayu-CLI, used by both the
// onboarding flow and the /connect command. Also imports API keys from known
// environment variables (and a local .env) into ~/.rayu/providers.json so keys
// the user already has in .env become first-class config entries.
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  type ProviderKind,
  loadRayuConfig,
  saveRayuConfig,
} from './rayuConfig.js'

export type ProviderPreset = {
  /** Stable provider id (also the config id). */
  id: string
  label: string
  kind: ProviderKind
  /** Base URL for openai-compatible providers (omit for anthropic / local-prompt). */
  baseURL?: string
  /** Sensible default model id (used until the live catalog is fetched). */
  defaultModel?: string
  /** Env var names whose value is the API key for this provider. */
  envKeys?: string[]
  /** True for endpoints where the user must type the base URL (no fixed host). */
  promptBaseURL?: boolean
}

// All confirmed OpenAI-compatible (tool calling + /v1/models), plus Anthropic.
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'anthropic', label: 'Anthropic (Claude)', kind: 'anthropic', envKeys: ['ANTHROPIC_API_KEY'] },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM (integrate.api.nvidia.com)',
    kind: 'openai-compatible',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'meta/llama-3.3-70b-instruct',
    envKeys: ['NVIDIA_API_KEY'],
  },
  {
    id: 'doubleword',
    label: 'Doubleword (api.doubleword.ai)',
    kind: 'openai-compatible',
    baseURL: 'https://api.doubleword.ai/v1',
    defaultModel: 'moonshotai/kimi-k2-6',
    envKeys: ['DOUBLE_WORD_API_KEY', 'DOUBLEWORD_API_KEY'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek (api.deepseek.com)',
    kind: 'openai-compatible',
    baseURL: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    envKeys: ['DEEPSEEK_API_KEY'],
  },
  {
    id: 'kimi',
    label: 'Kimi / Moonshot (api.moonshot.ai)',
    kind: 'openai-compatible',
    baseURL: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k2-0711-preview',
    envKeys: ['KIMI_FOR_CODE_API_KEY', 'KIMI_API_KEY', 'MOONSHOT_API_KEY'],
  },
  {
    id: 'openai',
    label: 'OpenAI (api.openai.com)',
    kind: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    envKeys: ['OPENAI_API_KEY'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (openrouter.ai)',
    kind: 'openai-compatible',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-3.5-sonnet',
    envKeys: ['OPENROUTER_API_KEY'],
  },
  {
    id: 'local',
    label: 'Local / custom OpenAI-compatible endpoint',
    kind: 'openai-compatible',
    promptBaseURL: true,
  },
]

/** Minimal .env reader: loads KEY=VALUE pairs into process.env (without overriding). */
function loadDotEnv(): void {
  for (const file of [join(process.cwd(), '.env')]) {
    if (!existsSync(file)) continue
    try {
      for (const raw of readFileSync(file, 'utf8').split('\n')) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        const eq = line.indexOf('=')
        if (eq <= 0) continue
        const key = line.slice(0, eq).trim()
        let val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
        if (key && process.env[key] === undefined) process.env[key] = val
      }
    } catch {
      // best-effort
    }
  }
}

/**
 * Import API keys from known env vars / .env into the provider config. Adds a
 * provider entry for each env key found that isn't already configured with a
 * key. Sets the first imported provider active only if none is active yet.
 * SECURITY: keys are written to the 0600 config file; never logged.
 */
export function migrateEnvKeysToConfig(): void {
  loadDotEnv()
  const cfg = loadRayuConfig()
  let changed = false
  for (const preset of PROVIDER_PRESETS) {
    const key = preset.envKeys
      ?.map(k => process.env[k])
      .find(v => typeof v === 'string' && v.length > 0)
    if (!key) continue
    const existing = cfg.providers.find(p => p.id === preset.id)
    if (existing?.apiKey) continue // already configured with a key
    if (existing) {
      existing.apiKey = key
      existing.baseURL ??= preset.baseURL
      existing.defaultModel ??= preset.defaultModel
    } else {
      cfg.providers.push({
        id: preset.id,
        kind: preset.kind,
        apiKey: key,
        ...(preset.baseURL ? { baseURL: preset.baseURL } : {}),
        ...(preset.defaultModel ? { defaultModel: preset.defaultModel } : {}),
      })
    }
    changed = true
  }
  if (changed) {
    cfg.activeProvider ??= cfg.providers[0]?.id
    saveRayuConfig(cfg)
  }
}
