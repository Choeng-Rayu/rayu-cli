// Pure, framework-free helpers for the user dashboard. Kept out of the React
// component so they can be unit-tested (web jest runs `lib/**/*.test.ts`).

export interface LedgerRow {
  id: number
  modelCode: string
  inTokens: number
  outTokens: number
  credits: number
  source: string
  createdAt: string
}

export interface ModelUsage {
  modelCode: string
  credits: number
  inTokens: number
  outTokens: number
  count: number
}

/** Aggregate ledger rows by model, sorted by credits consumed (desc). */
export function aggregateByModel(rows: LedgerRow[]): ModelUsage[] {
  const map = new Map<string, ModelUsage>()
  for (const r of rows) {
    const m =
      map.get(r.modelCode) ??
      { modelCode: r.modelCode, credits: 0, inTokens: 0, outTokens: 0, count: 0 }
    m.credits += r.credits
    m.inTokens += r.inTokens
    m.outTokens += r.outTokens
    m.count += 1
    map.set(r.modelCode, m)
  }
  return [...map.values()].sort((a, b) => b.credits - a.credits)
}

export interface PeriodProgress {
  fractionElapsed: number // 0..1
  daysElapsed: number
  daysLeft: number
  periodDays: number
}

/**
 * Billing-period progress derived from the period END (start = end -
 * periodDays). Hosted plans bill on a 30-day period (payments.service sets
 * currentPeriodEnd = now + 30d). Returns null when there is no active paid
 * period or the date is unparseable.
 */
export function periodProgress(
  periodEnd: string | null | undefined,
  now: number = Date.now(),
  periodDays = 30,
): PeriodProgress | null {
  if (!periodEnd) return null
  const end = Date.parse(periodEnd)
  if (Number.isNaN(end)) return null
  const totalMs = periodDays * 86_400_000
  const start = end - totalMs
  const elapsedMs = Math.min(totalMs, Math.max(0, now - start))
  const fractionElapsed = totalMs > 0 ? elapsedMs / totalMs : 0
  const daysLeft = Math.max(0, Math.ceil((end - now) / 86_400_000))
  const daysElapsed = Math.max(0, periodDays - daysLeft)
  return { fractionElapsed, daysElapsed, daysLeft, periodDays }
}

export interface UsageProjection {
  projectedCredits: number
  willExceed: boolean
}

/**
 * Project end-of-period credit usage from the credits used so far and how much
 * of the period has elapsed. Returns null until enough of the period has passed
 * (minFraction) to avoid wild early extrapolation, or when nothing was used.
 */
export function projectPeriodUsage(
  usedCredits: number,
  fractionElapsed: number,
  allowance: number | null,
  minFraction = 0.05,
): UsageProjection | null {
  if (usedCredits <= 0 || fractionElapsed < minFraction) return null
  const projectedCredits = Math.round(usedCredits / fractionElapsed)
  const willExceed = allowance != null && projectedCredits > allowance
  return { projectedCredits, willExceed }
}

/** Percent (0..100) of a capped resource consumed; 0 when there is no cap. */
export function pct(used: number, cap: number | null | undefined): number {
  if (cap == null || cap <= 0) return 0
  return Math.min(100, Math.max(0, (used / cap) * 100))
}

/**
 * A user is "premium" (Rayu-hosted, credit-bearing) when their plan has a
 * per-period credit allowance. Falls back to the known hosted plan codes.
 */
export function isPremiumPlan(
  creditsPerPeriod: number | null | undefined,
  planCode?: string,
): boolean {
  if (creditsPerPeriod != null) return true
  return ['pro', 'pro_plus', 'max'].includes(planCode ?? '')
}
