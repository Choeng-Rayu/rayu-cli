import { describe, expect, test } from 'bun:test'
import { formatBillingSummary } from '../src/commands/billing/billing.js'
import type { RayuEntitlements } from '../src/services/rayuAuth/rayuEntitlements.js'

const URL = 'https://rayucode.com/billing'

function makeEnt(
  plan: Partial<RayuEntitlements['plan']> = {},
  extra: Partial<RayuEntitlements> = {},
): RayuEntitlements {
  return {
    plan: {
      code: 'pro',
      name: 'Pro',
      priceCents: 2000,
      availability: 'active',
      currentPeriodEnd: null,
      ...plan,
    },
    maxDailyTurns: null,
    features: {},
    ...extra,
  }
}

describe('formatBillingSummary', () => {
  test('shows the current plan name, price, and the upgrade URL', () => {
    const out = formatBillingSummary(makeEnt(), URL)
    expect(out).toContain('Current plan: Pro ($20.00/mo)')
    expect(out).toContain('To upgrade your plan')
    expect(out).toContain(URL)
  })

  test('labels a zero-price plan as Free', () => {
    const out = formatBillingSummary(makeEnt({ name: 'Free', priceCents: 0 }), URL)
    expect(out).toContain('Current plan: Free (Free)')
    expect(out).toContain(URL)
  })

  test('includes renewal date, included credits, and top-up balance when present', () => {
    const out = formatBillingSummary(
      makeEnt(
        { currentPeriodEnd: '2026-08-01T00:00:00.000Z' },
        {
          creditAllowance: { creditsPerPeriod: 500, topUpEnabled: true },
          topupBalance: 25,
        },
      ),
      URL,
    )
    expect(out).toContain('Renews:')
    expect(out).toContain('Included credits per period: 500')
    expect(out).toContain('Top-up balance: 25 credits')
    expect(out).toContain(URL)
  })

  test('omits optional lines when not present', () => {
    const out = formatBillingSummary(makeEnt(), URL)
    expect(out).not.toContain('Renews:')
    expect(out).not.toContain('Included credits per period:')
    expect(out).not.toContain('Top-up balance:')
  })

  test('still returns the website link when entitlements are unavailable', () => {
    const out = formatBillingSummary(null, URL)
    expect(out).toContain('Could not load your plan')
    expect(out).toContain(URL)
  })
})
