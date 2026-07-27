import type { PlanCode } from '../common/enums'

export interface HostedModelSeed {
  code: string
  label: string
  /**
   * Name of the provider row (providers.name) this model routes through. All
   * routing config — base URL, wire format, auth scheme, key env — lives on that
   * provider, so a model only needs to name it plus its own upstream model id.
   */
  providerName: string
  upstreamModelId: string
  inputPricePer1MCents: number
  outputPricePer1MCents: number
  /** Credit charge for INPUT tokens (credits per 1M). */
  creditMultiplier: number
  /** Credit charge for OUTPUT tokens; defaults to the input charge. */
  outputCreditMultiplier?: number
  /** Credit charge for cache-HIT prompt tokens (absolute, not a ratio). */
  cacheReadCreditMultiplier?: number
  /** Credit charge for cache-CREATION prompt tokens; defaults to input. */
  cacheWriteCreditMultiplier?: number
  allowedPlanCodes: PlanCode[]
  /**
   * Context window in TOKENS (e.g. 200_000, 1_000_000). Optional: when omitted
   * the CLI falls back to its own default for the model. Admin-editable.
   */
  contextWindow?: number
  /** Model speaks a thinking/reasoning parameter. */
  supportsReasoning: boolean
  /** Model accepts image content blocks. */
  supportsImage: boolean
  /** Model accepts tool/function definitions. */
  supportsTools?: boolean
  enabled: boolean
}

// Provider names must match rows in the provider registry (see
// providers/providers.constants.ts PROVIDER_SEED and migration
// 0000000000009_providers). Renaming a provider in the dashboard detaches these
// seeds — seedDefaults then logs a warning and skips, rather than failing boot.
const OLLAMA_PROVIDER = 'rayu-ollama'

// First-time defaults only. Prices/multipliers/access are all admin-editable in
// the dashboard afterwards; the seed is non-destructive (create-if-missing).
// Rayu resells these via the (Phase 2) gateway using its own purchased keys.
export const MODEL_SEED: HostedModelSeed[] = [
  // DeepSeek V4 routed DIRECT to DeepSeek's own API via its Anthropic-compatible
  // endpoint (provider 'deepseek'). The gateway's built-in default for this
  // provider is Auth:x-api-key + Endpoint:anthropic (see knownProviderDefaults in
  // rayu-gateway/internal/config/config.go), so handleAnthropicMessages forwards
  // to https://api.deepseek.com/anthropic/v1/messages keyed by the gateway's
  // DEEPSEEK_API_KEY. This is the NATIVE rayu-hosted path — the CLI talks the
  // Anthropic SDK to the gateway's /anthropic base (see rayuHostedClient.ts), so
  // thinking / tools / prompt-cache usage map 1:1 with no OpenAI translation.
  // upstreamModelId is DeepSeek's own model id (NOT an Ollama `:cloud` tag):
  //   deepseek-v4-pro   → deepseek-v4-pro
  //   deepseek-v4-flash → deepseek-v4-flash
  // NOTE: for this to route, the 'deepseek' provider row must be enabled (Admin →
  // Providers) and DEEPSEEK_API_KEY must be set in the gateway env.
  // input==output price → FLAT billing, so creditMultiplier is exactly credits
  // per 1M tokens (pro = 1.0 → 1 credit/1M; flash = 0.33). The CLI resolves the
  // deepseek-v4 codes to 1M context — add a per-model override if the real
  // model's window is smaller.
  {
    code: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    providerName: 'deepseek',
    upstreamModelId: 'deepseek-v4-flash', // DeepSeek API model id (Anthropic-compatible)
    inputPricePer1MCents: 40,
    outputPricePer1MCents: 40, // input==output → flat 0.33 credits / 1M tokens
    creditMultiplier: 0.33, // cheaper tier — ~1/3 the credit cost of Pro
    allowedPlanCodes: ['pro', 'pro_plus', 'max'],
    // Context window in tokens (admin-editable; the CLI budgets against it).
    contextWindow: 1_000_000,
    // Capability flags: the gateway rejects an image block / thinking field
    // for a model whose flag is false, and the CLI warns the user to switch
    // models. Admin-tunable per model in the dashboard.
    supportsReasoning: true,
    supportsImage: false,
    enabled: true,
  },
  {
    code: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    providerName: 'deepseek',
    upstreamModelId: 'deepseek-v4-pro', // DeepSeek API model id (Anthropic-compatible)
    inputPricePer1MCents: 40,
    outputPricePer1MCents: 40, // input==output → flat, exactly 1 credit / 1M tokens
    creditMultiplier: 1, // reference tier (1 credit / 1M tokens at baseline)
    allowedPlanCodes: ['pro', 'pro_plus', 'max'],
    // Context window in tokens (admin-editable; the CLI budgets against it).
    contextWindow: 1_000_000,
    // Capability flags: the gateway rejects an image block / thinking field
    // for a model whose flag is false, and the CLI warns the user to switch
    // models. Admin-tunable per model in the dashboard.
    supportsReasoning: true,
    supportsImage: false,
    enabled: true,
  },
  {
    // LongCat 2.0 (Meituan) — 1M-context, Anthropic-compatible API at
    // https://api.longcat.chat/anthropic/v1/messages (auth: Authorization:
    // Bearer, handled per-provider in the gateway). Real provider pricing:
    // uncached input $0.75/1M, cached input $0.015/1M (≈0.02× input), output
    // $2.95/1M. creditMultiplier is the USER-FACING credit charge and is only a
    // sensible starting default here — the admin tunes it (and every price) in
    // the dashboard; nothing about the charge is hardcoded downstream.
    code: 'longcat-2',
    label: 'LongCat 2.0',
    providerName: 'longcat',
    upstreamModelId: 'LongCat-2.0',
    inputPricePer1MCents: 75, // $0.75 / 1M (uncached input)
    outputPricePer1MCents: 295, // $2.95 / 1M
    cacheReadCreditMultiplier: 0.02, // cached $0.015 / uncached $0.75 ≈ 0.02
    creditMultiplier: 0.5, // starting default — admin-tunable
    allowedPlanCodes: ['pro', 'pro_plus', 'max'],
    // Context window in tokens (admin-editable; the CLI budgets against it).
    contextWindow: 1_000_000,
    // Capability flags: the gateway rejects an image block / thinking field
    // for a model whose flag is false, and the CLI warns the user to switch
    // models. Admin-tunable per model in the dashboard.
    supportsReasoning: true,
    supportsImage: false,
    enabled: true,
  },

  // --- Ollama Cloud (provider = OLLAMA_PROVIDER, default 'rayu-ollama') -------
  // Ollama's HOSTED models (ollama.com), resold via the gateway with Rayu's own
  // OLLAMA_API_KEY. They speak Ollama's NATIVE Anthropic Messages API — but at
  // `{host}/v1/messages` (NO /anthropic path segment, unlike DeepSeek/LongCat)
  // with `Authorization: Bearer` — both handled per-provider in the gateway
  // (anthropicUpstream + anthropicUsesBearerAuth). Ollama does NOT do prompt
  // caching, so every prompt token bills at the input rate.
  //
  // creditMultiplier is the USER-FACING charge = CREDITS PER 1M TOKENS (baseline
  // is 1 credit / 1M tokens): 2.5 → 2.5 credits/1M, 0.75 → 0.75 credits/1M, etc.
  // input==output price keeps the charge FLAT (output tokens bill at the same
  // rate as input), matching the spec ("1M tokens = N credits"). Prices here are
  // internal cost-ledger placeholders (advisory) and, like every field, are
  // admin-editable in the dashboard — nothing is hardcoded downstream.
  //
  // NOTE: upstreamModelId must match the EXACT id in the Rayu Ollama Cloud
  // account (verify with `ollama list` / the Ollama dashboard); adjust per model
  // in the admin panel if a tag differs. Llama-4 and MiniMax-M3 credit rates were
  // not specified — defaulted (1.0 / 2.5) and are admin-tunable.
  {
    code: 'glm-5.2',
    label: 'GLM-5.2 (Ollama Cloud)',
    providerName: OLLAMA_PROVIDER,
    upstreamModelId: 'glm-5.2:cloud',
    inputPricePer1MCents: 60,
    outputPricePer1MCents: 60,
    creditMultiplier: 2.5, // 2.5 credits / 1M tokens
    allowedPlanCodes: ['pro', 'pro_plus', 'max'],
    // Context window in tokens (admin-editable; the CLI budgets against it).
    contextWindow: 1_000_000,
    // Capability flags: the gateway rejects an image block / thinking field
    // for a model whose flag is false, and the CLI warns the user to switch
    // models. Admin-tunable per model in the dashboard.
    supportsReasoning: true,
    supportsImage: false,
    enabled: true,
  },
  {
    code: 'kimi-k2.7',
    label: 'Kimi K2.7 Code (Ollama Cloud)',
    providerName: OLLAMA_PROVIDER,
    // Ollama's real id is 'kimi-k2.7-code' (NOT 'kimi-k2.7:cloud' — that 404s).
    // Verified against ollama.com/api/tags. NOTE: this model is subscription-gated
    // on Ollama (403 "requires a subscription") until the account's plan includes it.
    upstreamModelId: 'kimi-k2.7-code',
    inputPricePer1MCents: 60,
    outputPricePer1MCents: 60,
    creditMultiplier: 2.5, // 2.5 credits / 1M tokens
    allowedPlanCodes: ['pro', 'pro_plus', 'max'],
    // Context window in tokens (admin-editable; the CLI budgets against it).
    contextWindow: 256_000,
    // Capability flags: the gateway rejects an image block / thinking field
    // for a model whose flag is false, and the CLI warns the user to switch
    // models. Admin-tunable per model in the dashboard.
    supportsReasoning: true,
    supportsImage: false,
    enabled: true,
  },
  {
    code: 'minimax-m3',
    label: 'MiniMax M3 (Ollama Cloud)',
    providerName: OLLAMA_PROVIDER,
    upstreamModelId: 'minimax-m3:cloud',
    inputPricePer1MCents: 60,
    outputPricePer1MCents: 60,
    creditMultiplier: 2.5, // default (rate unspecified) — admin-tunable
    allowedPlanCodes: ['pro', 'pro_plus', 'max'],
    // Context window in tokens (admin-editable; the CLI budgets against it).
    contextWindow: 128_000,
    // Capability flags: the gateway rejects an image block / thinking field
    // for a model whose flag is false, and the CLI warns the user to switch
    // models. Admin-tunable per model in the dashboard.
    supportsReasoning: true,
    supportsImage: false,
    enabled: true,
  },
  {
    code: 'llama-4',
    label: 'Llama 4 (Ollama Cloud)',
    providerName: OLLAMA_PROVIDER,
    upstreamModelId: 'llama4:cloud',
    inputPricePer1MCents: 40,
    outputPricePer1MCents: 40,
    creditMultiplier: 1, // default (rate unspecified) — admin-tunable
    allowedPlanCodes: ['pro', 'pro_plus', 'max'],
    // Context window in tokens (admin-editable; the CLI budgets against it).
    contextWindow: 128_000,
    // Capability flags: the gateway rejects an image block / thinking field
    // for a model whose flag is false, and the CLI warns the user to switch
    // models. Admin-tunable per model in the dashboard.
    supportsReasoning: false,
    supportsImage: true,
    enabled: true,
  },
  {
    code: 'gpt-oss-120b',
    label: 'GPT-OSS 120B (Ollama Cloud)',
    providerName: OLLAMA_PROVIDER,
    upstreamModelId: 'gpt-oss:120b-cloud',
    inputPricePer1MCents: 30,
    outputPricePer1MCents: 30,
    creditMultiplier: 0.75, // 0.75 credits / 1M tokens
    allowedPlanCodes: ['pro', 'pro_plus', 'max'],
    // Context window in tokens (admin-editable; the CLI budgets against it).
    contextWindow: 128_000,
    // Capability flags: the gateway rejects an image block / thinking field
    // for a model whose flag is false, and the CLI warns the user to switch
    // models. Admin-tunable per model in the dashboard.
    supportsReasoning: true,
    supportsImage: false,
    enabled: true,
  },
  {
    code: 'qwen3.5-397b',
    label: 'Qwen3.5 397B (Ollama Cloud)',
    providerName: OLLAMA_PROVIDER,
    upstreamModelId: 'qwen3.5:397b-cloud',
    inputPricePer1MCents: 30,
    outputPricePer1MCents: 30,
    creditMultiplier: 0.75, // 0.75 credits / 1M tokens
    allowedPlanCodes: ['pro', 'pro_plus', 'max'],
    // Context window in tokens (admin-editable; the CLI budgets against it).
    contextWindow: 256_000,
    // Capability flags: the gateway rejects an image block / thinking field
    // for a model whose flag is false, and the CLI warns the user to switch
    // models. Admin-tunable per model in the dashboard.
    supportsReasoning: true,
    supportsImage: false,
    enabled: true,
  },
  {
    code: 'qwen3.5-122b',
    label: 'Qwen3.5 122B (Ollama Cloud)',
    providerName: OLLAMA_PROVIDER,
    upstreamModelId: 'qwen3.5:122b',
    inputPricePer1MCents: 30,
    outputPricePer1MCents: 30,
    creditMultiplier: 0.75, // 0.75 credits / 1M tokens
    allowedPlanCodes: ['pro', 'pro_plus', 'max'],
    // Context window in tokens (admin-editable; the CLI budgets against it).
    contextWindow: 256_000,
    // Capability flags: the gateway rejects an image block / thinking field
    // for a model whose flag is false, and the CLI warns the user to switch
    // models. Admin-tunable per model in the dashboard.
    supportsReasoning: true,
    supportsImage: false,
    enabled: true,
  },
]
