import { Plan, purchasablePlans, sortPlans, toPlanView } from './plans'

const plans: Plan[] = [
  { id: 6, code: 'enterprise', name: 'Enterprise', priceCents: 0, availability: 'coming_soon', limits: null },
  { id: 1, code: 'free', name: 'Free', priceCents: 0, availability: 'active', limits: null },
  { id: 2, code: 'basic', name: 'Basic', priceCents: 300, availability: 'active', limits: null },
  { id: 3, code: 'pro', name: 'Pro', priceCents: 1000, availability: 'active', limits: null },
  { id: 5, code: 'max', name: 'Max', priceCents: 5000, availability: 'active', limits: null },
  { id: 4, code: 'pro_plus', name: 'Ultra', priceCents: 2000, availability: 'active', limits: null },
]

describe('plans helpers', () => {
  it('sorts plans in canonical order (basic after free)', () => {
    expect(sortPlans(plans).map((p) => p.code)).toEqual([
      'free',
      'basic',
      'pro',
      'pro_plus',
      'max',
      'enterprise',
    ])
  })

  it('free plan is available with Get started CTA', () => {
    const v = toPlanView(plans.find((p) => p.code === 'free')!)
    expect(v.available).toBe(true)
    expect(v.ctaLabel).toBe('Get started')
    expect(v.priceLabel).toBe('Free')
  })

  it('basic plan is the $3/mo active tier (price from DB), highlighted, Subscribe CTA', () => {
    const v = toPlanView(plans.find((p) => p.code === 'basic')!)
    expect(v.available).toBe(true)
    expect(v.priceLabel).toBe('$3/mo')
    expect(v.ctaLabel).toBe('Subscribe')
    expect(v.highlight).toBe(true)
  })

  it('paid (rayu-hosted) plans are active with Upgrade CTA', () => {
    const pro = toPlanView(plans.find((p) => p.code === 'pro')!)
    expect(pro.available).toBe(true)
    expect(pro.ctaLabel).toBe('Upgrade')
    expect(pro.priceLabel).toBe('$10/mo')
  })

  it('a coming_soon plan maps to unavailable', () => {
    const cs = toPlanView({ id: 9, code: 'pro', name: 'Pro', priceCents: 1000, availability: 'coming_soon', limits: null })
    expect(cs.available).toBe(false)
    expect(cs.ctaLabel).toBe('Coming soon')
  })

  it('enterprise shows contact us / contact sales', () => {
    const ent = toPlanView(plans.find((p) => p.code === 'enterprise')!)
    expect(ent.priceLabel).toBe('Contact us')
    expect(ent.ctaLabel).toBe('Contact sales')
  })

  it('purchasablePlans returns the priced active tiers in order (no free/enterprise/coming_soon)', () => {
    expect(purchasablePlans(plans).map((p) => p.code)).toEqual([
      'basic',
      'pro',
      'pro_plus',
      'max',
    ])
    // A coming_soon priced plan is excluded.
    const withComingSoon: Plan[] = [
      ...plans.filter((p) => p.code !== 'pro'),
      { id: 3, code: 'pro', name: 'Pro', priceCents: 1000, availability: 'coming_soon', limits: null },
    ]
    expect(purchasablePlans(withComingSoon).map((p) => p.code)).toEqual(['basic', 'pro_plus', 'max'])
  })
})
