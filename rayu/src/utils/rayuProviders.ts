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
import { loadDotEnv } from './envUtils.js'


export type ProviderPreset = {
  /** Stable provider id (also the config id). */
  id: string
  label: string
  kind: ProviderKind
  /** Base URL for openai-compatible providers (omit for bedrock / local-prompt). */
  baseURL?: string
  /** Sensible default model id (used until the live catalog is fetched). */
  defaultModel?: string
  /** Provider-native small/fast model for lightweight work and haiku aliases. */
  smallFastModel?: string
  /** Env var names whose value is the API key for this provider. */
  envKeys?: string[]
  /** True for endpoints where the user must type the base URL (no fixed host). */
  promptBaseURL?: boolean
  /** For bedrock presets: which Bedrock API surface to use (default 'openai'). */
  bedrockApi?: 'openai' | 'anthropic'
  /**
   * True for presets authenticated via Google OAuth / Application Default
   * Credentials rather than a typed API key (e.g. Gemini on Vertex AI). The
   * /connect flow runs ADC detection / loopback login + project/region prompts
   * instead of the API-key step.
   */
  requiresOAuth?: boolean
}

// --- AWS Bedrock (API key / bearer token) -----------------------------------
// Bedrock exposes an OpenAI-compatible Chat Completions API on the
// `bedrock-runtime` endpoint. It is region-scoped and authenticated with a
// Bedrock API key (the AWS_BEARER_TOKEN_BEDROCK bearer token). Both
// `GET /v1/models` and `POST /v1/chat/completions` work with that token, so
// Rayu can reuse its OpenAI-compatible adapter + model-catalog fetch verbatim.

/** Default AWS region used for Bedrock when none is specified. */
export const DEFAULT_BEDROCK_REGION = 'us-east-1'

/** Build the OpenAI-compatible Bedrock base URL for a given AWS region. */
export function bedrockBaseURL(region: string): string {
  const r = (region || DEFAULT_BEDROCK_REGION).trim()
  // The bedrock-runtime endpoint serves the OpenAI Chat Completions API under
  // the /openai/v1 path (POST /openai/v1/chat/completions), authenticated with
  // a Bedrock API key. (The bare /v1 path returns UnknownOperation.)
  return `https://bedrock-runtime.${r}.amazonaws.com/openai/v1`
}

/** AWS regions that commonly support the Bedrock runtime endpoint. */
export const BEDROCK_REGIONS: Array<{ id: string; label: string }> = [
  { id: 'us-east-1', label: 'US East (N. Virginia) · us-east-1' },
  { id: 'us-east-2', label: 'US East (Ohio) · us-east-2' },
  { id: 'us-west-2', label: 'US West (Oregon) · us-west-2' },
  { id: 'ap-south-1', label: 'Asia Pacific (Mumbai) · ap-south-1' },
  { id: 'ap-southeast-1', label: 'Asia Pacific (Singapore) · ap-southeast-1' },
  { id: 'ap-southeast-2', label: 'Asia Pacific (Sydney) · ap-southeast-2' },
  { id: 'ap-northeast-1', label: 'Asia Pacific (Tokyo) · ap-northeast-1' },
  { id: 'eu-central-1', label: 'Europe (Frankfurt) · eu-central-1' },
  { id: 'eu-west-1', label: 'Europe (Ireland) · eu-west-1' },
  { id: 'eu-west-3', label: 'Europe (Paris) · eu-west-3' },
]

// --- Google Vertex AI (Gemini via OAuth / ADC) ------------------------------
// Vertex AI exposes an OpenAI-compatible Chat Completions endpoint under the
// per-region `…/endpoints/openapi` path, authenticated with a Google Cloud
// OAuth bearer token (cloud-platform scope) rather than a static API key. Rayu
// reuses its OpenAI-compatible adapter with a fetch wrapper that injects a
// freshly-minted token. The provider is project + region scoped.

/** Stable provider id for the Gemini/Vertex (OAuth) preset. */
export const GEMINI_VERTEX_PROVIDER_ID = 'gemini-vertex'

/** Default GCP location for Vertex chat. `global` serves the newest Gemini
 *  models (3.x) and also the 2.x line, so it's the most compatible default. */
export const DEFAULT_VERTEX_REGION = 'global'

/** Vertex AI host for a location: the `global` location uses the un-prefixed
 *  host, every regional location uses the `{region}-` prefix. */
export function vertexHost(region: string): string {
  const r = (region || DEFAULT_VERTEX_REGION).trim()
  return r === 'global'
    ? 'aiplatform.googleapis.com'
    : `${r}-aiplatform.googleapis.com`
}

/**
 * Build the OpenAI-compatible Vertex AI base URL for a project + region. The
 * Chat Completions endpoint lives at `{base}/chat/completions`; model ids are
 * sent with a `google/` publisher prefix (handled at request time).
 */
export function vertexBaseURL(project: string, region: string): string {
  const r = (region || DEFAULT_VERTEX_REGION).trim()
  const p = project.trim()
  return `https://${vertexHost(r)}/v1beta1/projects/${p}/locations/${r}/endpoints/openapi`
}

/** GCP locations that commonly serve Gemini on Vertex AI. `global` first — it
 *  hosts the newest Gemini models and is the recommended default. */
export const VERTEX_REGIONS: Array<{ id: string; label: string }> = [
  { id: 'global', label: 'Global (recommended — newest Gemini models) · global' },
  { id: 'us-central1', label: 'US Central (Iowa) · us-central1' },
  { id: 'us-east1', label: 'US East (S. Carolina) · us-east1' },
  { id: 'us-east4', label: 'US East (N. Virginia) · us-east4' },
  { id: 'us-west1', label: 'US West (Oregon) · us-west1' },
  { id: 'europe-west1', label: 'Europe West (Belgium) · europe-west1' },
  { id: 'europe-west4', label: 'Europe West (Netherlands) · europe-west4' },
  { id: 'asia-northeast1', label: 'Asia Northeast (Tokyo) · asia-northeast1' },
  { id: 'asia-southeast1', label: 'Asia Southeast (Singapore) · asia-southeast1' },
]


// All confirmed OpenAI-compatible providers (tool calling + /v1/models), plus
// AWS Bedrock via its OpenAI-compatible bedrock-runtime endpoint (authenticated
// with a Bedrock API key / bearer token). Rayu connects to OpenAI-compatible
// endpoints; Bedrock is routed through the same adapter once a region + API key
// are supplied via /connect.
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'nvidia',
    label: 'NVIDIA NIM (integrate.api.nvidia.com)',
    kind: 'openai-compatible',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'meta/llama-3.3-70b-instruct',
    smallFastModel: 'nvidia/llama-3.1-nemotron-nano-8b-v1',
    envKeys: ['NVIDIA_API_KEY'],
  },
  {
    id: 'doubleword',
    label: 'Doubleword (api.doubleword.ai)',
    kind: 'openai-compatible',
    baseURL: 'https://api.doubleword.ai/v1',
    defaultModel: 'moonshotai/Kimi-K2.6',
    smallFastModel: 'Qwen/Qwen3.5-9B',
    envKeys: ['DOUBLE_WORD_API_KEY', 'DOUBLEWORD_API_KEY'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek (api.deepseek.com)',
    kind: 'openai-compatible',
    baseURL: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    smallFastModel: 'deepseek-v4-flash',
    envKeys: ['DEEPSEEK_API_KEY'],
  },
  {
    id: 'kimi-moonshot',
    label: 'Kimi / Moonshot (api.moonshot.ai)',
    kind: 'openai-compatible',
    baseURL: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k2.6',
    smallFastModel: 'kimi-k2.6',
    envKeys: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
  },
  {
    id: 'kimi-for-code',
    label: 'Kimi for Code (api.kimi.com/coding)',
    kind: 'openai-compatible',
    baseURL: 'https://api.kimi.com/coding/v1',
    defaultModel: 'kimi-for-coding',
    smallFastModel: 'kimi-for-coding',
    envKeys: ['KIMI_FOR_CODE_API_KEY'],
  },
  {
    id: 'openai',
    label: 'OpenAI (api.openai.com)',
    kind: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    smallFastModel: 'gpt-4o-mini',
    envKeys: ['OPENAI_API_KEY'],
  },
  {
    // Google Gemini via its OpenAI-compatible surface. The
    // generativelanguage endpoint exposes /chat/completions and /models under
    // the /v1beta/openai path, authenticated with a Gemini API key, so Rayu can
    // reuse its OpenAI-compatible adapter + live model-catalog fetch verbatim.
    // (The OAuth/Vertex path is a separate preset — see GEMINI_VERTEX_PRESET.)
    // No hardcoded defaultModel: the catalog is fetched live and the picker
    // chooses (e.g. gemini-2.5-flash / gemini-3.x-flash as they ship).
    id: 'gemini',
    label: 'Google Gemini — API key (generativelanguage.googleapis.com)',
    kind: 'openai-compatible',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  },
  {
    // Gemini on Google Vertex AI, authenticated with Google OAuth /
    // Application Default Credentials (no static API key). Project + region
    // scoped; the base URL is computed from the values chosen/detected in
    // /connect (vertexBaseURL). Chat is served through the OpenAI-compatible
    // adapter via a fetch wrapper that injects a fresh bearer token.
    id: GEMINI_VERTEX_PROVIDER_ID,
    label: 'Google Gemini — Vertex AI (OAuth / ADC) · recommended for heavy use',
    kind: 'vertex',
    requiresOAuth: true,
  },
  {
    // "Login with Gemini" — interactive Google sign-in (user's Desktop OAuth
    // client). Served by the @google/genai adapter in Vertex mode on the
    // `global` location, using the project from the client/login. No API key
    // or gcloud/ADC required.
    id: 'gemini-login',
    label: 'Login with Gemini (Google account) · free/Pro consumer quota',
    kind: 'genai',
    requiresOAuth: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (openrouter.ai)',
    kind: 'openai-compatible',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-3.5-sonnet',
    smallFastModel: 'openai/gpt-4o-mini',
    envKeys: ['OPENROUTER_API_KEY'],
  },
  {
    id: 'bedrock',
    label: 'AWS Bedrock — open models (OpenAI-compatible: gpt-oss, qwen, …)',
    kind: 'bedrock',
    bedrockApi: 'openai',
    // No fixed baseURL: it is region-scoped and computed from the region the
    // user selects in /connect (bedrockBaseURL). Models are fetched live.
    envKeys: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    id: 'bedrock-anthropic',
    label: 'AWS Bedrock — Claude (Anthropic Messages API)',
    kind: 'bedrock',
    bedrockApi: 'anthropic',
    // Region-scoped; uses @anthropic-ai/bedrock-sdk with the Bedrock API key.
    // No envKeys here so AWS_BEARER_TOKEN_BEDROCK maps to a single (openai)
    // provider during env migration; pick this explicitly via /connect.
  },
  {
    id: 'local',
    label: 'Local / custom OpenAI-compatible endpoint',
    kind: 'openai-compatible',
    promptBaseURL: true,
  },
]



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
  for (const provider of cfg.providers) {
    const preset = PROVIDER_PRESETS.find(p => p.id === provider.id)
    if (!preset) continue
    if (!provider.baseURL && preset.baseURL) {
      provider.baseURL = preset.baseURL
      changed = true
    }
    if (!provider.defaultModel && preset.defaultModel) {
      provider.defaultModel = preset.defaultModel
      changed = true
    }
    if (!provider.smallFastModel && preset.smallFastModel) {
      provider.smallFastModel = preset.smallFastModel
      changed = true
    }
  }
  for (const preset of PROVIDER_PRESETS) {
    const key = preset.envKeys
      ?.map(k => process.env[k])
      .find(v => typeof v === 'string' && v.length > 0)
    if (!key) continue
    const existing = cfg.providers.find(p => p.id === preset.id)
    if (existing?.apiKey) continue // already configured with a key
    // Bedrock is region-scoped: derive region from AWS env (or default) and
    // compute the OpenAI-compatible bedrock-runtime base URL from it.
    const isBedrock = preset.kind === 'bedrock'
    const region = isBedrock
      ? (process.env.AWS_REGION ||
          process.env.AWS_DEFAULT_REGION ||
          DEFAULT_BEDROCK_REGION)
      : undefined
    const baseURL = isBedrock ? bedrockBaseURL(region as string) : preset.baseURL
    if (existing) {
      existing.apiKey = key
      existing.baseURL ??= baseURL
      existing.defaultModel ??= preset.defaultModel
      existing.smallFastModel ??= preset.smallFastModel
      if (isBedrock) existing.awsRegion ??= region
    } else {
      cfg.providers.push({
        id: preset.id,
        kind: preset.kind,
        apiKey: key,
        ...(baseURL ? { baseURL } : {}),
        ...(preset.defaultModel ? { defaultModel: preset.defaultModel } : {}),
        ...(preset.smallFastModel ? { smallFastModel: preset.smallFastModel } : {}),
        ...(isBedrock ? { awsRegion: region } : {}),
      })
    }
    changed = true
  }
  if (changed) {
    cfg.activeProvider ??= cfg.providers[0]?.id
    saveRayuConfig(cfg)
  }
}
