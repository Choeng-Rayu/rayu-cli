import {
  aggregateByModel,
  avgCreditsPerRequest,
  busiestDay,
  dailyCreditSeries,
  isPremiumPlan,
  type LedgerRow,
  pct,
  periodProgress,
  projectPeriodUsage,
  providerBreakdown,
  totals,
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

describe('dailyCreditSeries', () => {
  const now = Date.parse('2026-06-20T12:00:00Z')

  it('buckets credits by UTC day and fills missing days with 0', () => {
    const rows: LedgerRow[] = [
      row({ id: 1, credits: 3, createdAt: '2026-06-20T01:00:00Z' }),
      row({ id: 2, credits: 2, createdAt: '2026-06-20T09:00:00Z' }),
      row({ id: 3, credits: 5, createdAt: '2026-06-18T09:00:00Z' }),
    ]
    const series = dailyCreditSeries(rows, 7, now)
    expect(series).toHaveLength(7)
    // last entry = today (2026-06-20) = 3 + 2 = 5
    expect(series[series.length - 1]).toEqual({ label: '2026-06-20', value: 5 })
    // 2026-06-18 had 5
    expect(series.find((p) => p.label === '2026-06-18')?.value).toBe(5)
    // a day with no usage is 0
    expect(series.find((p) => p.label === '2026-06-19')?.value).toBe(0)
  })

  it('returns all-zero series when there are no rows', () => {
    const series = dailyCreditSeries([], 5, now)
    expect(series).toHaveLength(5)
    expect(series.every((p) => p.value === 0)).toBe(true)
  })
})

describe('totals & averages', () => {
  const rows: LedgerRow[] = [
    row({ id: 1, credits: 2, inTokens: 100, outTokens: 50 }),
    row({ id: 2, credits: 4, inTokens: 200, outTokens: 100 }),
  ]
  it('sums credits, tokens, and requests', () => {
    expect(totals(rows)).toEqual({ credits: 6, inTokens: 300, outTokens: 150, requests: 2 })
  })
  it('computes average credits per request', () => {
    expect(avgCreditsPerRequest(rows)).toBe(3)
    expect(avgCreditsPerRequest([])).toBe(0)
  })
})

describe('providerBreakdown', () => {
  it('maps model codes to providers, sums credits, sorts desc, handles unknown', () => {
    const rows: LedgerRow[] = [
      row({ id: 1, modelCode: 'deepseek-v4-flash', credits: 2 }),
      row({ id: 2, modelCode: 'deepseek-v4-pro', credits: 5 }),
      row({ id: 3, modelCode: 'mystery-model', credits: 1 }),
    ]
    const codeToProvider = {
      'deepseek-v4-flash': 'deepseek',
      'deepseek-v4-pro': 'deepseek',
    }
    const bd = providerBreakdown(rows, codeToProvider)
    expect(bd).toEqual([
      { label: 'deepseek', value: 7 },
      { label: 'unknown', value: 1 },
    ])
  })
})

describe('busiestDay', () => {
  it('returns the max-usage day, or null when all zero', () => {
    expect(
      busiestDay([
        { label: '2026-06-18', value: 1 },
        { label: '2026-06-19', value: 9 },
        { label: '2026-06-20', value: 4 },
      ]),
    ).toEqual({ label: '2026-06-19', value: 9 })
    expect(busiestDay([{ label: '2026-06-20', value: 0 }])).toBeNull()
  })
})
