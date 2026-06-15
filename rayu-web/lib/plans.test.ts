import { Plan, sortPlans, toPlanView } from './plans'

const plans: Plan[] = [
  { id: 5, code: 'enterprise', name: 'Enterprise', priceCents: 0, availability: 'coming_soon', limits: null },
  { id: 1, code: 'free', name: 'Free', priceCents: 0, availability: 'active', limits: null },
  { id: 2, code: 'pro', name: 'Pro', priceCents: 1000, availability: 'coming_soon', limits: null },
  { id: 4, code: 'max', name: 'Max', priceCents: 5000, availability: 'coming_soon', limits: null },
  { id: 3, code: 'pro_plus', name: 'Pro+', priceCents: 2000, availability: 'coming_soon', limits: null },
]

describe('plans helpers', () => {
  it('sorts plans in canonical order', () => {
    expect(sortPlans(plans).map((p) => p.code)).toEqual([
      'free',
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
    expect(v.highlight).toBe(true)
  })

  it('paid plans are coming soon', () => {
    const pro = toPlanView(plans.find((p) => p.code === 'pro')!)
    expect(pro.available).toBe(false)
    expect(pro.ctaLabel).toBe('Coming soon')
    expect(pro.priceLabel).toBe('$10/mo')
  })

  it('enterprise shows contact us / contact sales', () => {
    const ent = toPlanView(plans.find((p) => p.code === 'enterprise')!)
    expect(ent.priceLabel).toBe('Contact us')
    expect(ent.ctaLabel).toBe('Contact sales')
  })
})
