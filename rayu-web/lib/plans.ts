export type PlanAvailability = 'active' | 'coming_soon'

export interface Plan {
  id: number
  code: string
  name: string
  priceCents: number
  availability: PlanAvailability
  limits: Record<string, unknown> | null
}

export interface PlanView {
  code: string
  name: string
  priceLabel: string
  ctaLabel: string
  available: boolean
  highlight: boolean
}

// Pure mapping from a backend Plan to the props the Plans page renders.
export function toPlanView(plan: Plan): PlanView {
  const isFree = plan.code === 'free'
  const isEnterprise = plan.code === 'enterprise'
  const available = plan.availability === 'active'

  let priceLabel: string
  if (isEnterprise) priceLabel = 'Contact us'
  else if (plan.priceCents === 0) priceLabel = 'Free'
  else priceLabel = `$${(plan.priceCents / 100).toFixed(0)}/mo`

  let ctaLabel: string
  if (available && isFree) ctaLabel = 'Get started'
  else if (available && !isEnterprise) ctaLabel = 'Upgrade'
  else if (isEnterprise) ctaLabel = 'Contact sales'
  else ctaLabel = 'Coming soon'

  return {
    code: plan.code,
    name: plan.name,
    priceLabel,
    ctaLabel,
    available,
    highlight: isFree,
  }
}

export function sortPlans(plans: Plan[]): Plan[] {
  const order = ['free', 'pro', 'pro_plus', 'max', 'enterprise']
  return [...plans].sort(
    (a, b) => order.indexOf(a.code) - order.indexOf(b.code),
  )
}
