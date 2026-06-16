import type { PlanAvailability, PlanCode } from '../common/enums'

export interface PlanSeed {
  code: PlanCode
  name: string
  priceCents: number
  availability: PlanAvailability
  limits: Record<string, unknown> | null
}

// Canonical plan catalog. Free is active; all paid tiers are "coming soon"
// in phase 1. Limits are placeholders for the future Rayu-hosted model proxy.
export const PLAN_SEED: PlanSeed[] = [
  {
    code: 'free',
    name: 'Free',
    priceCents: 0,
    availability: 'active',
    limits: { bringYourOwnKey: true, requests: 'unlimited' },
  },
  {
    code: 'pro',
    name: 'Pro',
    priceCents: 1000,
    availability: 'active',
    limits: null,
  },
  {
    code: 'pro_plus',
    name: 'Pro+',
    priceCents: 2000,
    availability: 'active',
    limits: null,
  },
  {
    code: 'max',
    name: 'Max',
    priceCents: 5000,
    availability: 'coming_soon',
    limits: null,
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    priceCents: 0,
    availability: 'coming_soon',
    limits: { contactSales: true },
  },
]
