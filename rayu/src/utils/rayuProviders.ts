// Shared registry of built-in provider presets for Rayu-CLI, used by both the
// onboarding flow and the /connect command. Also imports API keys from known
// environment variables (and a local .env) into ~/.rayu/providers.json so keys
// the user already has in .env become first-class config entries.
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  type ProviderKind,
  type RayuProvider,
  getActiveProvider,
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
  /** For bedrock presets: which Bedrock API surface to use (default 'converse'). */
  bedrockApi?: 'openai' | 'anthropic' | 'converse'
  /**
   * True for presets authenticated via Google OAuth / Application Default
   * Credentials rather than a typed API key (e.g. Gemini on Vertex AI). The
   * /connect flow runs ADC detection / loopback login + project/region prompts
   * instead of the API-key step.
   */
  requiresOAuth?: boolean
}

// --- AWS Bedrock (API key / bearer token) -----------------------------------
// AWS Bedrock exposes an OpenAI-compatible Chat Completions API on the
// `bedrock-mantle` endpoint (AWS-recommended). It is region-scoped and
// authenticated with a Bedrock API key (the AWS_BEARER_TOKEN_BEDROCK bearer
// token). Both `GET /v1/models` and `POST /v1/chat/completions` work with that
// token, so Rayu reuses its OpenAI-compatible adapter + model-catalog fetch
// verbatim. Mantle (unlike the bare bedrock-runtime OpenAI surface) properly
// separates reasoning models' chain-of-thought into `reasoning_content` and
// parses native tool calls — required for Kimi K2 Thinking et al.

/** Default AWS region used for Bedrock when none is specified. */
export const DEFAULT_BEDROCK_REGION = 'us-east-1'

/** Build the OpenAI-compatible Bedrock base URL for a given AWS region. */
export function bedrockBaseURL(region: string): string {
  const r = (region || DEFAULT_BEDROCK_REGION).trim()
  // The recommended `bedrock-mantle` endpoint serves the OpenAI Chat Completions
  // API at /v1/chat/completions and the model catalog at /v1/models. Model IDs
  // on mantle use the `<vendor>.<model>` form (e.g. moonshotai.kimi-k2-thinking).
  return `https://bedrock-mantle.${r}.api.aws/v1`
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


// --- Ollama (local) ---------------------------------------------------------
// Ollama serves an OpenAI-compatible API at http://localhost:11434/v1 (plus its
// native /api surface). No API key is required. The address can be overridden
// with the standard OLLAMA_HOST env var (a bare port, host:port, or full URL),
// matching the Ollama CLI, so Rayu auto-detects a server started elsewhere.
export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1'

/** OpenAI-compatible base URL for a local Ollama server, honoring OLLAMA_HOST. */
export function ollamaBaseURL(): string {
  let raw = (process.env.OLLAMA_HOST || '').trim()
  if (!raw) return OLLAMA_DEFAULT_BASE_URL
  if (/^\d+$/.test(raw)) raw = `localhost:${raw}` // bare port, e.g. "11434"
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}` // host or host:port
  raw = raw.replace(/\/+$/, '')
  if (!/\/v1(\/.*)?$/.test(raw)) raw = `${raw}/v1` // ensure the OpenAI /v1 base
  return raw
}


// All confirmed OpenAI-compatible providers (tool calling + /v1/models), plus
// AWS Bedrock via its OpenAI-compatible bedrock-runtime endpoint (authenticated
// with a Bedrock API key / bearer token). Rayu connects to OpenAI-compatible
// endpoints; Bedrock is routed through the same adapter once a region + API key
// are supplied via /connect.
/** Stable provider id for the Rayu-hosted gateway provider (registered on
 *  login for paid users; not connected manually via /connect). */
export const RAYU_HOSTED_PROVIDER_ID = 'rayu-hosted'
export const RAYU_HOSTED_PROVIDER_LABEL = 'Rayu (hosted)'

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    // First-party Anthropic API (the Console — console.anthropic.com). Uses the
    // native Anthropic Messages API via getAnthropicClient() (kind:'anthropic'
    // → getAPIProvider() === 'anthropic'), the SAME path the app uses for
    // first-party Claude. That means extended THINKING and the full CONTEXT
    // window (incl. the 1M-token context beta) are supported NATIVELY — not
    // emulated through the OpenAI-compatible adapter. Authenticated with a
    // Console API key (sk-ant-…) sent as x-api-key directly to
    // api.anthropic.com. No baseURL: first-party endpoint is the SDK default.
    id: 'anthropic',
    label: 'Anthropic — Claude (console.anthropic.com API key) · native thinking + context',
    kind: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
    smallFastModel: 'claude-haiku-4-5-20251001',
    envKeys: ['ANTHROPIC_API_KEY'],
  },
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
    // DeepSeek Web (chat.deepseek.com) — browser-authenticated access to
    // deepseek-v4-pro-1m with a 1M-token context window. Uses the web app's
    // internal API (POST /api/v0/chat/completion) with PoW solving, not the
    // standard OpenAI-compatible API. Authenticated with a userToken from the
    // browser's localStorage. Requires a paid Rayu plan (Basic and up).
    // Use DEEPSEEK_OAUTH_WEB_TOKEN (userToken) + DEEPSEEK_OAUTH_WEB_COOKIE
    // (browser cookies for WAF bypass). Set USE_DEEPSEEK_OAUTH=true to enable.
    id: 'deepseek-web',
    label: 'DeepSeek Web (chat.deepseek.com) · browser auth · deepseek-v4-pro-1m 1M ctx',
    kind: 'deepseek-web',
    defaultModel: 'deepseek-v4-pro-1m',
    smallFastModel: 'deepseek-v4-pro-1m',
    envKeys: ['DEEPSEEK_OAUTH_WEB_TOKEN'],
  },
  {
    // Z.ai — GLM family (Zhipu AI). OpenAI-compatible Chat Completions at
    // https://api.z.ai/api/paas/v4/chat/completions, authenticated with a Bearer
    // API key. GLM-5.2 is the current flagship coding/agent model with a 1M-token
    // context window; GLM-4.6 is 200K; GLM-4.5 / 4.5-Air are 128K. Thinking is
    // NATIVE: GLM-4.5+ emit chain-of-thought in the `reasoning_content` field,
    // which the OpenAI adapter surfaces as a thinking block. Z.ai has NO
    // OpenAI-style `GET /models`, so the full lineup comes from the curated
    // catalog in curatedProviderModels.ts (merged with any live fetch). Per-model
    // context windows live in KNOWN_MODEL_CONTEXT (rayuConfig.ts). Docs:
    // https://docs.z.ai/api-reference/llm/chat-completion
    id: 'glm',
    label: 'GLM — Z.ai (api.z.ai) · GLM-5.2 1M ctx / GLM-4.6 200K · native thinking',
    kind: 'openai-compatible',
    baseURL: 'https://api.z.ai/api/paas/v4',
    defaultModel: 'glm-5.2',
    smallFastModel: 'glm-4.5-air',
    envKeys: ['ZAI_API_KEY', 'ZHIPUAI_API_KEY', 'GLM_API_KEY'],
  },
  {
    // MiniMax — M-series language models. OpenAI-compatible Chat Completions at
    // https://api.minimax.io/v1/chat/completions (Bearer MINIMAX_API_KEY).
    // MiniMax-M3 is the frontier coding/agent model with a 1M-token context;
    // MiniMax-M2 / M2.x are 204,800. Thinking is NATIVE and ON by default
    // (M2.x always think; M3 thinks unless disabled): reasoning is returned
    // either as `reasoning_content` (reasoning_split) or inline <think>…</think>
    // at the start of the message — the OpenAI adapter surfaces BOTH as a
    // thinking block (processInlineThink). Per-model context lives in
    // KNOWN_MODEL_CONTEXT (rayuConfig.ts). Docs:
    // https://platform.minimax.io/docs/api-reference/text-openai-api
    id: 'minimax',
    label: 'MiniMax (api.minimax.io) · M3 1M ctx / M2 reasoning · native thinking',
    kind: 'openai-compatible',
    baseURL: 'https://api.minimax.io/v1',
    defaultModel: 'MiniMax-M2',
    smallFastModel: 'MiniMax-M2',
    envKeys: ['MINIMAX_API_KEY'],
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
    // Fugu — Sakana AI's multi-agent system (Japan). Although it's an agentic
    // multi-agent system under the hood, it's exposed like a standard LLM
    // through the OpenAI-compatible Sakana API: `POST /v1/chat/completions`
    // (and the Responses API) at https://api.sakana.ai/v1, authenticated with a
    // Bearer SAKANA_API_KEY. Rayu reuses its OpenAI-compatible adapter + live
    // `GET /v1/models` catalog verbatim. Two models ship: `fugu` (default;
    // routes across providers) and `fugu-ultra` (premium). Both have a 1M-token
    // context window — see KNOWN_MODEL_CONTEXT in rayuConfig.ts. Docs:
    // https://console.sakana.ai/get-started
    id: 'fugu',
    label: 'Fugu — Sakana AI (api.sakana.ai)',
    kind: 'openai-compatible',
    baseURL: 'https://api.sakana.ai/v1',
    defaultModel: 'fugu',
    smallFastModel: 'fugu',
    envKeys: ['SAKANA_API_KEY'],
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
    // GitHub Copilot — sign in with GitHub (OAuth device flow) and use your
    // Copilot subscription's models (Claude, GPT, Gemini, …) via Copilot's
    // OpenAI-compatible endpoint (api.githubcopilot.com). No API key to paste:
    // the GitHub OAuth token is exchanged for a short-lived Copilot token that
    // is auto-refreshed. Reuses the OpenAI adapter through a token-injecting
    // fetch wrapper (handled by kind:'copilot' in client.ts).
    id: 'copilot',
    label: 'GitHub Copilot (sign in with GitHub) · uses your Copilot subscription',
    kind: 'copilot',
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
    id: 'xai',
    label: 'xAI / Grok (api.x.ai)',
    kind: 'openai-compatible',
    baseURL: 'https://api.x.ai/v1',
    defaultModel: 'grok-4',
    smallFastModel: 'grok-3-mini',
    envKeys: ['XAI_API_KEY'],
  },
  {
    id: 'groq',
    label: 'Groq (api.groq.com)',
    kind: 'openai-compatible',
    baseURL: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    smallFastModel: 'llama-3.1-8b-instant',
    envKeys: ['GROQ_API_KEY'],
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI (api.fireworks.ai)',
    kind: 'openai-compatible',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    envKeys: ['FIREWORKS_API_KEY'],
  },
  {
    id: 'togetherai',
    label: 'Together AI (api.together.xyz)',
    kind: 'openai-compatible',
    baseURL: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    envKeys: ['TOGETHER_API_KEY', 'TOGETHERAI_API_KEY'],
  },
  {
    id: 'cerebras',
    label: 'Cerebras (api.cerebras.ai)',
    kind: 'openai-compatible',
    baseURL: 'https://api.cerebras.ai/v1',
    defaultModel: 'llama-3.3-70b',
    envKeys: ['CEREBRAS_API_KEY'],
  },
  {
    id: 'baseten',
    label: 'Baseten (inference.baseten.co)',
    kind: 'openai-compatible',
    baseURL: 'https://inference.baseten.co/v1',
    envKeys: ['BASETEN_API_KEY'],
  },
  {
    id: 'deepinfra',
    label: 'DeepInfra (api.deepinfra.com)',
    kind: 'openai-compatible',
    baseURL: 'https://api.deepinfra.com/v1/openai',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
    envKeys: ['DEEPINFRA_API_KEY'],
  },
  {
    // Hugging Face Inference Providers — an OpenAI-compatible router
    // (router.huggingface.co/v1) that fans a single `<org>/<model>` id out to
    // the available inference providers (novita, together, fireworks, …).
    // `GET /v1/models` returns the live cross-provider catalog, so Rayu's
    // generic openai-compatible adapter + model fetch work verbatim. Auth is a
    // Hugging Face access token (hf_…), read from the standard HF env vars.
    id: 'huggingface',
    label: 'Hugging Face — Inference Providers (router.huggingface.co)',
    kind: 'openai-compatible',
    baseURL: 'https://router.huggingface.co/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V4-Pro',
    smallFastModel: 'deepseek-ai/DeepSeek-V4-Flash',
    envKeys: ['HF_TOKEN', 'HUGGINGFACE_API_KEY', 'HUGGING_FACE_HUB_TOKEN'],
  },
  {
    id: 'bedrock',
    label: 'AWS Bedrock — all models (Converse API: Claude, Kimi, DeepSeek, …)',
    kind: 'bedrock',
    bedrockApi: 'converse',
    // No fixed baseURL: region-scoped, called through the AWS SDK
    // Converse/ConverseStream API. Models are fetched live. Converse is
    // model-agnostic and natively separates reasoning + tool use.
    envKeys: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  {
    id: 'bedrock-openai',
    label: 'AWS Bedrock — OpenAI-compatible (bedrock-mantle: gpt-oss, qwen, …)',
    kind: 'bedrock',
    bedrockApi: 'openai',
    // Region-scoped OpenAI Chat Completions endpoint (bedrockBaseURL → mantle).
    // No envKeys so AWS_BEARER_TOKEN_BEDROCK maps to the default (converse)
    // provider during env migration; pick this explicitly via /connect.
  },
  {
    id: 'bedrock-anthropic',
    label: 'AWS Bedrock — Claude (Anthropic Messages API)',
    kind: 'bedrock',
    bedrockApi: 'anthropic',
    // Region-scoped; uses @anthropic-ai/bedrock-sdk with the Bedrock API key.
    // No envKeys here so AWS_BEARER_TOKEN_BEDROCK maps to a single (converse)
    // provider during env migration; pick this explicitly via /connect.
  },
  {
    id: 'kiro',
    label: 'Kiro — Claude via AWS (API key or kiro-cli login)',
    kind: 'kiro',
    defaultModel: 'claude-sonnet-4.6',
    smallFastModel: 'claude-haiku-4.5',
    envKeys: ['KIRO_API_KEY'],
    // No fixed baseURL: region-scoped AWS CodeWhisperer endpoint, reached via a
    // dedicated adapter (src/services/api/kiroAdapter.ts). Auth + the adapter
    // are lazy-loaded only when the active provider is kind:'kiro'.
  },
  {
    id: 'ollama',
    label: 'Ollama (local · auto-detect)',
    kind: 'openai-compatible',
    baseURL: OLLAMA_DEFAULT_BASE_URL,
    // No envKeys / API key: Ollama needs none. Connected via /connect →
    // Localhost → Ollama, which probes the server and lists its pulled models.
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


// --- Provider display names (header / status line) --------------------------
// Short, human-friendly names shown next to the model in the logo/header (e.g.
// "gemini-3.5-flash · Vertex AI") in place of the generic "API Usage Billing".

/** Short, branded names keyed by provider id. */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  nvidia: 'NVIDIA',
  doubleword: 'Doubleword',
  deepseek: 'DeepSeek',
  glm: 'GLM',
  minimax: 'MiniMax',
  'kimi-moonshot': 'Kimi',
  'kimi-for-code': 'Kimi for Code',
  fugu: 'Fugu',
  openai: 'OpenAI',
  gemini: 'Gemini',
  [GEMINI_VERTEX_PROVIDER_ID]: 'Vertex AI',
  'gemini-login': 'Gemini',
  openrouter: 'OpenRouter',
  xai: 'xAI',
  groq: 'Groq',
  fireworks: 'Fireworks AI',
  togetherai: 'Together AI',
  cerebras: 'Cerebras',
  baseten: 'Baseten',
  deepinfra: 'DeepInfra',
  huggingface: 'Hugging Face',
  bedrock: 'AWS Bedrock',
  'bedrock-openai': 'AWS Bedrock',
  'bedrock-anthropic': 'AWS Bedrock',
  kiro: 'Kiro',
  copilot: 'GitHub Copilot',
  'rayu-hosted': 'Rayu',
  'deepseek-web': 'DeepSeek Web',
  ollama: 'Ollama',
  local: 'Local',
}

/** Fallback name derived from the provider kind when the id isn't known. */
function providerKindName(kind: ProviderKind): string {
  switch (kind) {
    case 'vertex':
      return 'Vertex AI'
    case 'bedrock':
      return 'AWS Bedrock'
    case 'genai':
      return 'Gemini'
    case 'kiro':
      return 'Kiro'
    case 'copilot':
      return 'GitHub Copilot'
    case 'anthropic':
      return 'Anthropic'
    default:
      return 'OpenAI-compatible'
  }
}

/**
 * Human-friendly display name for a configured provider — id-aware, with a
 * kind-based fallback, plus a localhost hint so custom Ollama endpoints still
 * read as "Ollama".
 */
export function providerDisplayName(provider: RayuProvider): string {
  const known = PROVIDER_DISPLAY_NAMES[provider.id]
  if (known) return known
  if (
    provider.kind === 'openai-compatible' &&
    provider.baseURL &&
    /(?:\/\/|@)(?:localhost|127\.0\.0\.1)(?::\d+)?|:11434(?:\/|$)/.test(
      provider.baseURL,
    )
  ) {
    return 'Ollama'
  }
  return providerKindName(provider.kind)
}

/**
 * Short display name for the ACTIVE provider (e.g. "Vertex AI", "Ollama",
 * "NVIDIA"), or undefined when no provider is configured yet.
 */
export function getActiveProviderDisplayName(): string | undefined {
  const p = getActiveProvider()
  return p ? providerDisplayName(p) : undefined
}
