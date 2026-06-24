import {
  aggregateByModel,
  isPremiumPlan,
  type LedgerRow,
  pct,
  periodProgress,
  projectPeriodUsage,
} from './dashboard'

const row = (over: Partial<LedgerRow> = {}): LedgerRow => ({
  id: 1,
  modelCode: 'deepseek-v4-pro',
  inTokens: 1000,
  outTokens: 500,
  credits: 2,
  source: 'plan',
  createdAt: '2026-06-20T00:00:00Z',
  ...over,
})

describe('aggregateByModel', () => {
  it('groups by model, sums tokens/credits/count, sorts by credits desc', () => {
    const rows: LedgerRow[] = [
      row({ id: 1, modelCode: 'deepseek-v4-flash', credits: 1, inTokens: 100, outTokens: 50 }),
      row({ id: 2, modelCode: 'deepseek-v4-pro', credits: 5, inTokens: 200, outTokens: 80 }),
      row({ id: 3, modelCode: 'deepseek-v4-flash', credits: 2, inTokens: 100, outTokens: 50 }),
    ]
    const agg = aggregateByModel(rows)
    expect(agg.map((m) => m.modelCode)).toEqual(['deepseek-v4-pro', 'deepseek-v4-flash'])
    const flash = agg.find((m) => m.modelCode === 'deepseek-v4-flash')!
    expect(flash.credits).toBe(3)
    expect(flash.inTokens).toBe(200)
    expect(flash.outTokens).toBe(100)
    expect(flash.count).toBe(2)
  })

  it('returns [] for no rows', () => {
    expect(aggregateByModel([])).toEqual([])
  })
})

describe('periodProgress', () => {
  const now = Date.parse('2026-06-20T00:00:00Z')

  it('computes elapsed/left from a 30-day period ending 10 days out', () => {
    const p = periodProgress('2026-06-30T00:00:00Z', now)!
    expect(p.daysLeft).toBe(10)
    expect(p.daysElapsed).toBe(20)
    expect(p.fractionElapsed).toBeCloseTo(0.667, 2)
    expect(p.periodDays).toBe(30)
  })

  it('clamps a just-started period to ~0 elapsed', () => {
    const p = periodProgress('2026-07-20T00:00:00Z', now)! // 30 days out = just started
    expect(p.daysLeft).toBe(30)
    expect(p.fractionElapsed).toBeCloseTo(0, 3)
  })

  it('returns null for missing or invalid dates', () => {
    expect(periodProgress(null, now)).toBeNull()
    expect(periodProgress(undefined, now)).toBeNull()
    expect(periodProgress('not-a-date', now)).toBeNull()
  })
})

describe('projectPeriodUsage', () => {
  it('projects to end of period and flags within-allowance', () => {
    const p = projectPeriodUsage(10, 0.5, 50)!
    expect(p.projectedCredits).toBe(20)
    expect(p.willExceed).toBe(false)
  })

  it('flags a projected overage', () => {
    const p = projectPeriodUsage(40, 0.5, 50)!
    expect(p.projectedCredits).toBe(80)
    expect(p.willExceed).toBe(true)
  })

  it('returns null too early in the period or with no usage', () => {
    expect(projectPeriodUsage(10, 0.01, 50)).toBeNull()
    expect(projectPeriodUsage(0, 0.5, 50)).toBeNull()
  })
})

describe('pct', () => {
  it('computes a clamped percentage', () => {
    expect(pct(25, 50)).toBe(50)
    expect(pct(60, 50)).toBe(100) // clamps at 100
    expect(pct(10, null)).toBe(0) // no cap
    expect(pct(10, 0)).toBe(0)
  })
})

describe('isPremiumPlan', () => {
  it('is premium when a credit allowance exists', () => {
    expect(isPremiumPlan(50, 'pro')).toBe(true)
    expect(isPremiumPlan(0, 'pro')).toBe(true) // allowance present (even 0) -> hosted
  })
  it('falls back to hosted plan codes when allowance is null', () => {
    expect(isPremiumPlan(null, 'pro')).toBe(true)
    expect(isPremiumPlan(null, 'max')).toBe(true)
    expect(isPremiumPlan(null, 'free')).toBe(false)
    expect(isPremiumPlan(null, 'basic')).toBe(false)
  })
})
