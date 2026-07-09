import type { PlanCode } from '../common/enums'

export interface HostedModelSeed {
  code: string
  label: string
  provider: string
  upstreamBaseUrl: string
  upstreamModelId: string
  inputPricePer1MCents: number
  outputPricePer1MCents: number
  creditMultiplier: number
  cacheReadCreditMultiplier?: number
  cacheWriteCreditMultiplier?: number
  allowedPlanCodes: PlanCode[]
  enabled: boolean
}

// Ollama Cloud's provider name is configurable via OLLAMA_PROVIDER_NAME (default
// 'rayu-ollama') so it can be renamed without a code change. It MUST match the
// gateway's OLLAMA_PROVIDER_NAME env (the gateway keys its Ollama routing +
// OLLAMA_API_KEY off the same value); read once here at module load.
const OLLAMA_PROVIDER = process.env.OLLAMA_PROVIDER_NAME?.trim() || 'rayu-ollama'

// First-time defaults only. Prices/multipliers/access are all admin-editable in
// the dashboard afterwards; the seed is non-destructive (create-if-missing).
// Rayu resells these via the (Phase 2) gateway using its own purchased keys.
export const MODEL_SEED: HostedModelSeed[] = [
  // DeepSeek V4 routed through OLLAMA CLOUD (provider OLLAMA_PROVIDER, Rayu's
  // OLLAMA_API_KEY) — the official DeepSeek route is dropped. ONLY the routing
  // changed; prices/multipliers are the prior admin-editable defaults (tune for
  // Ollama's real cost in the dashboard). NOTE: set upstreamModelId to the EXACT
  // deepseek id in your Ollama account (Ollama serves deepseek as e.g.
  // deepseek-v3.1:671b-cloud). The CLI resolves the deepseek-v4 codes to 1M
  // context — add a per-model override if the Ollama model's window is smaller.
  {
    code: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    provider: OLLAMA_PROVIDER,
    upstreamBaseUrl: 'https://ollama.com',
    upstreamModelId: 'deepseek-v3.1:671b-cloud', // verify/set exact Ollama id
    inputPricePer1MCents: 14,
    outputPricePer1MCents: 28,
    creditMultiplier: 0.33, // cheaper tier — ~1/3 the credit cost of Pro
    allowedPlanCodes: ['pro', 'pro_plus', 'max'],
    enabled: true,
  },
  {
    code: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    provider: OLLAMA_PROVIDER,
    upstreamBaseUrl: 'https://ollama.com',
    upstreamModelId: 'deepseek-v3.1:671b-cloud', // verify/set exact Ollama id
    inputPricePer1MCents: 174,
    outputPricePer1MCents: 348,
    creditMultiplier: 1, // reference tier (1 credit / 1M tokens at baseline)
    allowedPlanCodes: ['pro', 'pro_plus', 'max'],
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
    provider: 'longcat',
    upstreamBaseUrl: 'https://api.longcat.chat',
    upstreamModelId: 'LongCat-2.0',
    inputPricePer1MCents: 75, // $0.75 / 1M (uncached input)
    outputPricePer1MCents: 295, // $2.95 / 1M
    cacheReadCreditMultiplier: 0.02, // cached $0.015 / uncached $0.75 ≈ 0.02
    creditMultiplier: 0.5, // starting default — admin-tunable
    allowedPlanCodes: ['pro', 'pro_plus', 'max'],
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
    provider: OLLAMA_PROVIDER,
    upstreamBaseUrl: 'https://ollama.com',
    upstreamModelId: 'glm-5.2:cloud',
    inputPricePer1MCents: 60,
    outputPricePer1MCents: 60,
    creditMultiplier: 2.5, // 2.5 credits / 1M tokens
    allowedPlanCodes: ['pro', 'pro_plus', 'max'],
    enabled: true,
  },
  {
    code: 'kimi-k2.7',
    label: 'Kimi K2.7 (Ollama Cloud)',
    provider: OLLAMA_PROVIDER,
    upstreamBaseUrl: 'https://ollama.com',
    upstreamModelId: 'kimi-k2.7:cloud',
    inputPricePer1MCents: 60,
    outputPricePer1MCents: 60,
    creditMultiplier: 2.5, // 2.5 credits / 1M tokens
    allowedPlanCodes: ['pro', 'pro_plus', 'max'],
    enabled: true,
  },
  {
    code: 'minimax-m3',
    label: 'MiniMax M3 (Ollama Cloud)',
    provider: OLLAMA_PROVIDER,
    upstreamBaseUrl: 'https://ollama.com',
    upstreamModelId: 'minimax-m3:cloud',
    inputPricePer1MCents: 60,
    outputPricePer1MCents: 60,
    creditMultiplier: 2.5, // default (rate unspecified) — admin-tunable
    allowedPlanCodes: ['pro', 'pro_plus', 'max'],
    enabled: true,
  },
  {
    code: 'llama-4',
    label: 'Llama 4 (Ollama Cloud)',
    provider: OLLAMA_PROVIDER,
    upstreamBaseUrl: 'https://ollama.com',
    upstreamModelId: 'llama4:cloud',
    inputPricePer1MCents: 40,
    outputPricePer1MCents: 40,
    creditMultiplier: 1, // default (rate unspecified) — admin-tunable
    allowedPlanCodes: ['pro', 'pro_plus', 'max'],
    enabled: true,
  },
  {
    code: 'gpt-oss-120b',
    label: 'GPT-OSS 120B (Ollama Cloud)',
    provider: OLLAMA_PROVIDER,
    upstreamBaseUrl: 'https://ollama.com',
    upstreamModelId: 'gpt-oss:120b-cloud',
    inputPricePer1MCents: 30,
    outputPricePer1MCents: 30,
    creditMultiplier: 0.75, // 0.75 credits / 1M tokens
    allowedPlanCodes: ['pro', 'pro_plus', 'max'],
    enabled: true,
  },
  {
    code: 'qwen3.5-397b',
    label: 'Qwen3.5 397B (Ollama Cloud)',
    provider: OLLAMA_PROVIDER,
    upstreamBaseUrl: 'https://ollama.com',
    upstreamModelId: 'qwen3.5:397b-cloud',
    inputPricePer1MCents: 30,
    outputPricePer1MCents: 30,
    creditMultiplier: 0.75, // 0.75 credits / 1M tokens
    allowedPlanCodes: ['pro', 'pro_plus', 'max'],
    enabled: true,
  },
  {
    code: 'qwen3.5-122b',
    label: 'Qwen3.5 122B (Ollama Cloud)',
    provider: OLLAMA_PROVIDER,
    upstreamBaseUrl: 'https://ollama.com',
    upstreamModelId: 'qwen3.5:122b',
    inputPricePer1MCents: 30,
    outputPricePer1MCents: 30,
    creditMultiplier: 0.75, // 0.75 credits / 1M tokens
    allowedPlanCodes: ['pro', 'pro_plus', 'max'],
    enabled: true,
  },
]
