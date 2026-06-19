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
}

export interface FeatureCatalogItem {
  key: string
  label: string
  description: string
  supportsLimit: boolean
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

export interface HostedModel {
  id: number
  code: string
  label: string
  provider: string
  upstreamBaseUrl: string
  upstreamModelId: string
  inputPricePer1MCents: number
  outputPricePer1MCents: number
  creditMultiplier: number
  allowedPlanCodes: string[] | null
  enabled: boolean
}

export interface AppSettings {
  id: number
  baselineCreditsPer1M: number
  topupCentsPer1kCredits: number
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
