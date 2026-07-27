// Shared response types for the admin pages (mirror the backend payloads).

export interface AdminUser {
  id: number
  email: string | null
  displayName: string | null
  role: string
  status: string
  createdAt: string
  lastActiveAt: string | null
}

export interface UserList {
  items: AdminUser[]
  total: number
  page: number
  pageSize: number
}

export interface UserDetail {
  user: AdminUser & { avatarUrl: string | null }
  plan: { code: string; name: string; priceCents: number } | null
  subscription: {
    id: number
    status: string
    startedAt: string
    currentPeriodEnd: string | null
  } | null
}

export interface PaymentItem {
  id: number
  userEmail?: string | null
  planCode: string | null
  provider: string
  amountCents: number
  currency: string
  status: string
  externalRef: string | null
  createdAt: string
  paidAt: string | null
}

export interface FeatureEntitlement {
  enabled: boolean
  limit?: number | null
}

export interface PlanAdminView {
  id: number
  code: string
  name: string
  priceCents: number
  availability: 'active' | 'coming_soon'
  maxDailyTurns: number | null
  creditsPerPeriod: number | null
  topUpEnabled: boolean
  features: Record<string, FeatureEntitlement>
  /**
   * Hosted models this plan may use. Stored per model
   * (hosted_models.allowedPlanCodes) but edited here as a per-plan checklist.
   */
  allowedModelCodes: string[]
}

/** A hosted model as it appears in the plan model-access checklist. */
export interface PlanModelOption {
  code: string
  label: string
  provider: string
  enabled: boolean
}

/** Response of GET /admin/plans. */
export interface PlansResponse {
  catalog: FeatureCatalogItem[]
  models: PlanModelOption[]
  plans: PlanAdminView[]
}

export interface FeatureCatalogItem {
  key: string
  label: string
  description: string
  supportsLimit: boolean
}

// Admin promo/discount code (mirrors the backend PromoCode model).
export interface PromoCode {
  id: number
  code: string
  description: string | null
  discountType: 'percent' | 'fixed'
  discountValue: number
  appliesToPlans: string[] | null // null/[] = all plans
  maxRedemptions: number | null // null = unlimited
  usedCount: number
  startsAt: string | null
  endsAt: string | null
  active: boolean
  createdAt: string
  updatedAt: string
}

export interface AdminAnalytics {
  totals: {
    totalUsers: number
    activeUsers24h: number
    activeUsers7d: number
    activeUsers30d: number
  }
  statusBreakdown: { active: number; suspended: number; banned: number }
  planDistribution: Array<{ code: string; name: string; priceCents: number; users: number }>
  paidVsFree: { free: number; paid: number }
  revenue: {
    totalCents: number
    paidCount: number
    byMonth: Array<{ month: string; cents: number; count: number }>
  }
  signupsByDay: Array<{ date: string; count: number }>
  activeByDay: Array<{ date: string; count: number }>
  usageByProvider: Array<{ provider: string; count: number }>
  usageByTool: Array<{ tool: string; count: number }>
  profit: {
    revenueCents: number
    aiCostCents: number
    marginCents: number
    creditsConsumed: number
  }
  creditsByModel: Array<{ modelCode: string; credits: number; costCents: number }>
  topUsers: Array<{ id: number; email: string | null; displayName: string | null; count: number }>
  canceledSubscriptions: number
}

export interface FeedbackItem {
  id: number
  type: string
  message: string
  rating: number | null
  createdAt: string
  userId: number
  userEmail: string | null
  userName: string | null
}

// Green-forward chart palette aligned to the site theme.
export const CHART_PALETTE = ['#00FF88', '#00cc6e', '#36c5ff', '#ffbd2e', '#FF3366', '#9b8cff']

// --- Provider registry -------------------------------------------------------
// The wire format an upstream speaks. The gateway translates its canonical
// Anthropic Messages request into this format, so a provider of ANY of these can
// be added from the dashboard with no client release.
export const PROVIDER_FORMATS = [
  'anthropic_messages',
  'openai_chat',
  'openai_responses',
  'genai',
  'bedrock_anthropic',
] as const
export type ProviderFormat = (typeof PROVIDER_FORMATS)[number]

export const PROVIDER_AUTH_SCHEMES = ['bearer', 'x_api_key', 'x_goog_api_key'] as const
export type ProviderAuthScheme = (typeof PROVIDER_AUTH_SCHEMES)[number]

/** Human labels for the format select. */
export const PROVIDER_FORMAT_LABELS: Record<ProviderFormat, string> = {
  anthropic_messages: 'Anthropic Messages',
  openai_chat: 'OpenAI compatible (chat/completions)',
  openai_responses: 'OpenAI Responses',
  genai: 'Google GenAI (Gemini)',
  bedrock_anthropic: 'AWS Bedrock (Anthropic on bedrock-runtime)',
}

/**
 * An admin-managed upstream provider. NOTE there is no apiKey field by design:
 * keys are separate, encrypted provider_api_keys rows managed through
 * /admin/providers/:name/keys, and a secret is never returned by the API.
 */
export interface Provider {
  id: number
  name: string
  label: string
  format: ProviderFormat
  baseUrl: string
  endpointPath: string | null
  authScheme: ProviderAuthScheme
  supportsReasoning: boolean
  supportsImage: boolean
  enabled: boolean
  /** How many hosted models point at this provider (blocks unsafe deletes). */
  modelCount: number
}

/** Per-provider routing health, reported by the GATEWAY (which holds the keys). */
export interface ProviderHealth {
  providerId: number
  name: string
  format: string
  baseUrl: string
  endpoint: string
  authScheme: string
  /** How many API keys the provider has configured. */
  keyCount: number
  keyPresent: boolean
  /** How many of those keys can serve traffic right now (not cooling/invalid). */
  usableKeys: number
  /** Per-key health, masked — never a secret. */
  keys: ProviderKeyHealth[]
  enabled: boolean
  routable: boolean
  configError?: string
}

/**
 * An API key as the BACKEND stores it: masked only. The secret is write-only —
 * it is accepted once on create/replace, encrypted, and never returned again.
 */
export interface ProviderKeyView {
  id: number
  label: string
  maskedKey: string
  priority: number
  enabled: boolean
  status: 'active' | 'rate_limited' | 'invalid' | 'disabled'
  lastUsedAt: string | null
  cooldownUntil: string | null
  lastError: string | null
  createdAt: string
}

/** Why a provider test failed — maps to the field an admin has to correct. */
export type ProviderTestClassification =
  | 'ok'
  | 'bad_api_key'
  | 'unknown_model'
  | 'bad_base_url'
  | 'format_mismatch'
  | 'rate_limited'
  | 'upstream_error'

/**
 * Which stage of the upstream handshake succeeded. `null` = never reached, so it
 * cannot be judged (e.g. the key when the host did not answer at all). This is
 * what turns "something is wrong" into "one field is wrong".
 */
export interface ProviderTestChecks {
  reachable: boolean | null
  keyAccepted: boolean | null
  modelAccepted: boolean | null
}

/** Result of POST /v1/_provider-test on the gateway (a real, unbilled request). */
export interface ProviderTestResult {
  ok: boolean
  classification: ProviderTestClassification
  message: string
  checks: ProviderTestChecks
  suggestion?: string
  httpStatus?: number
  latencyMs: number
  providerName: string
  format: string
  endpoint: string
  modelCode?: string
  upstreamModelId?: string
  keyId?: number
  maskedKey?: string
}

/** One API key's live health as the GATEWAY sees it (masked, never the secret). */
export interface ProviderKeyHealth {
  id: number
  label: string
  maskedKey: string
  priority: number
  enabled: boolean
  status: 'active' | 'rate_limited' | 'invalid' | 'disabled'
  /** Set while the key is cooling down after a 429. */
  cooldownUntil?: string
}

export interface HostedModel {
  id: number
  code: string
  label: string
  providerId: number
  /** Present when the API returns the model with its provider row attached. */
  provider?: Pick<Provider, 'id' | 'name' | 'label' | 'format' | 'enabled'>
  upstreamModelId: string
  inputPricePer1MCents: number
  outputPricePer1MCents: number
  /** INPUT credit charge (credits per 1M tokens). Name kept: it is what the CLI sees. */
  creditMultiplier: number
  /** OUTPUT credit charge (credits per 1M tokens). */
  outputCreditMultiplier: number
  cacheReadCreditMultiplier: number | null
  cacheWriteCreditMultiplier: number | null
  allowedPlanCodes: string[] | null
  /**
   * Context window in TOKENS, or null when unset (the CLI then falls back to its
   * own default for the model). The CLI budgets auto-compaction and context
   * warnings against this, so it is admin-owned.
   */
  contextWindow: number | null
  supportsReasoning: boolean
  supportsImage: boolean
  /** Whether tool/function calling may be sent to this model. */
  supportsTools: boolean
  enabled: boolean
}

export interface AppSettings {
  id: number
  baselineCreditsPer1M: number
  /** How many credits $1 buys. 0 = top-up unavailable. */
  creditsPerDollar: number
  /** Smallest top-up purchase, in cents (100 = $1). */
  minTopupCents: number
  maxConcurrentStreams: number
  maxTokensPerRequest: number
  maxRequestsPer5h: number
  baselineModelCode: string | null
  assumedInputRatio: number
  assumedUsagePercent: number
  infraCostCentsPerUser: number
}

export interface ProjectionModel {
  code: string
  label: string
  enabled: boolean
  inputPricePer1MCents: number
  outputPricePer1MCents: number
  blendedCentsPer1M: number
  currentMultiplier: number
  suggestedMultiplier: number
  costPerCreditCents: number
}

export interface ProjectionPlan {
  code: string
  name: string
  priceCents: number
  creditsPerPeriod: number | null
  unlimited: boolean
  worstModelCode: string | null
  worstCostPerCreditCents: number
  worstCaseMonthlyCostCents: number | null
  expectedMonthlyCostCents: number | null
  marginCents: number | null
  worstCaseMarginCents: number | null
  marginNegative: boolean
}

export interface CreditProjection {
  settings: {
    baselineCreditsPer1M: number
    assumedInputRatio: number
    assumedUsagePercent: number
    infraCostCentsPerUser: number
    baselineModelCode: string | null
  }
  models: ProjectionModel[]
  plans: ProjectionPlan[]
}
