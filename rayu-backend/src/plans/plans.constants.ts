import type { PlanAvailability, PlanCode } from '../common/enums'
import { allDisabled, allEnabled } from '../common/features'

export interface PlanSeed {
  code: PlanCode
  name: string
  priceCents: number
  availability: PlanAvailability
  limits: Record<string, unknown> | null
}

// Canonical plan catalog used ONLY to create plans the first time they are
// missing. These are DEFAULTS — every field (price, availability, limits,
// feature entitlements) is editable by the super-admin at runtime and stored
// in MySQL. The seed is non-destructive (see PlansService.seedDefaults) so
// admin changes are never overwritten on restart.
//
// - free:  bring-your-own-key, feature-limited (admin can open features up),
//          with a default daily turn cap (admin-changeable).
// - basic: $3/mo, all features, bring-your-own-key (no Rayu gateway needed).
// - pro / pro_plus / max: Rayu-hosted credit tiers, purchasable (active) by
//   default; all features on, with a per-period credit allowance + top-up.
// - enterprise: contact sales.
export const PLAN_SEED: PlanSeed[] = [
  {
    code: 'free',
    name: 'Free',
    priceCents: 0,
    availability: 'active',
    limits: {
      bringYourOwnKey: true,
      maxDailyTurns: 50,
      features: allDisabled(),
    },
  },
  {
    code: 'basic',
    name: 'Basic',
    priceCents: 300,
    availability: 'active',
    limits: {
      bringYourOwnKey: true,
      maxDailyTurns: null,
      features: allEnabled(),
    },
  },
  {
    code: 'pro',
    name: 'Pro',
    priceCents: 1000,
    availability: 'active',
    limits: {
      maxDailyTurns: null,
      features: allEnabled(),
      creditsPerPeriod: 50,
      topUpEnabled: true,
    },
  },
  {
    code: 'pro_plus',
    name: 'Ultra',
    priceCents: 2000,
    availability: 'active',
    limits: {
      maxDailyTurns: null,
      features: allEnabled(),
      creditsPerPeriod: 115,
      topUpEnabled: true,
    },
  },
  {
    code: 'max',
    name: 'Max',
    priceCents: 5000,
    availability: 'active',
    limits: {
      maxDailyTurns: null,
      features: allEnabled(),
      creditsPerPeriod: 300,
      topUpEnabled: true,
    },
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    priceCents: 0,
    availability: 'coming_soon',
    limits: { contactSales: true, maxDailyTurns: null, features: allEnabled() },
  },
]
