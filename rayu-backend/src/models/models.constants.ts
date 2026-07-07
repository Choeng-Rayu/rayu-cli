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

// First-time defaults only. Prices/multipliers/access are all admin-editable in
// the dashboard afterwards; the seed is non-destructive (create-if-missing).
// Rayu resells these via the (Phase 2) gateway using its own purchased keys.
export const MODEL_SEED: HostedModelSeed[] = [
  {
    code: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    provider: 'deepseek',
    upstreamBaseUrl: 'https://api.deepseek.com/v1',
    upstreamModelId: 'deepseek-v4-flash',
    inputPricePer1MCents: 14, // $0.14 / 1M
    outputPricePer1MCents: 28, // $0.28 / 1M
    creditMultiplier: 0.33, // cheaper model — ~1/3 the credit cost of Pro
    allowedPlanCodes: ['pro', 'pro_plus', 'max'],
    enabled: true,
  },
  {
    code: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    provider: 'deepseek',
    upstreamBaseUrl: 'https://api.deepseek.com/v1',
    upstreamModelId: 'deepseek-v4-pro',
    inputPricePer1MCents: 174, // $1.74 / 1M
    outputPricePer1MCents: 348, // $3.48 / 1M
    creditMultiplier: 1, // reference model (1 credit = 1e6/baselineCreditsPer1M tokens)
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
]
