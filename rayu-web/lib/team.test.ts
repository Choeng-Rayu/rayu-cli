import {
  allocatedCredits,
  allowanceSplit,
  billingStatusLabel,
  bucketUsedPct,
  creditExpiryLabel,
  equalSplit,
  isOverAllocated,
  isTeamBillable,
  isValidSlug,
  joinBlockedReason,
  joinLinkLabel,
  normalizeDomainInput,
  poolUsedPct,
  purchaseWarning,
  slugify,
  teamAllowance,
  type JoinLinkPreview,
  type Team,
  type TeamJoinLink,
  type TeamMember,
  type TeamTopupQuote,
} from './team'

function member(over: Partial<TeamMember> = {}): TeamMember {
  return {
    userId: 1,
    email: 'a@company.com',
    displayName: 'A',
    avatarUrl: null,
    role: 'member',
    status: 'active',
    bucketQuota: 250,
    bucketCredits: 250,
    joinedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  }
}

function team(over: Partial<Team> = {}): Team {
  return {
    id: 21,
    name: 'Acme',
    slug: 'acme',
    ssoDomain: '@company.com',
    status: 'active',
    adminId: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    plan: { code: 'enterprise', name: 'Team', priceCents: 5000, isTeamPlan: true, seatCredits: 0 },
    subscription: { status: 'active', currentPeriodEnd: '2099-01-01T00:00:00.000Z' },
    creditPool: { totalCredits: 1000, usedCredits: 250, remainingCredits: 750, periodEnd: null },
    ...over,
  }
}

describe('pool + quota math', () => {
  it('reports pool usage as a clamped percentage', () => {
    expect(poolUsedPct(team().creditPool)).toBe(25)
    expect(poolUsedPct(null)).toBe(0)
    expect(poolUsedPct({ totalCredits: 0, usedCredits: 0, remainingCredits: 0, periodEnd: null })).toBe(0)
    // A pool that somehow over-drained never shows more than 100%.
    expect(
      poolUsedPct({ totalCredits: 100, usedCredits: 500, remainingCredits: 0, periodEnd: null }),
    ).toBe(100)
  })

  it('sums only ACTIVE member quotas', () => {
    const members = [member(), member({ userId: 2 }), member({ userId: 3, status: 'removed' })]
    expect(allocatedCredits(members)).toBe(500)
  })

  it('flags over-allocation (allowed, but worth telling the admin)', () => {
    const pool = team().creditPool
    const five = Array.from({ length: 5 }, (_, i) => member({ userId: i + 1 }))
    expect(isOverAllocated(five, pool)).toBe(true) // 5 × 250 = 1250 > 1000
    expect(isOverAllocated(five.slice(0, 4), pool)).toBe(false) // exactly 1000
  })

  it('computes the equal split the backend defaults to', () => {
    expect(equalSplit(team().creditPool, 4)).toBe(250)
    expect(equalSplit(team().creditPool, 3)).toBe(333) // floor, never over-promise
    expect(equalSplit(team().creditPool, 0)).toBe(0)
    expect(equalSplit(null, 4)).toBe(0)
  })

  it('reports a member’s own quota usage', () => {
    expect(bucketUsedPct(member({ bucketQuota: 200, bucketCredits: 50 }))).toBe(75)
    // No personal quota — the member draws straight from the pool.
    expect(bucketUsedPct(member({ bucketQuota: 0, bucketCredits: 0 }))).toBe(0)
  })
})

describe('slug + domain input', () => {
  it('derives a valid slug from a team name', () => {
    expect(slugify('Acme Corp')).toBe('acme-corp')
    expect(slugify('  Hello   World!! ')).toBe('hello-world')
    expect(slugify('ACME')).toBe('acme')
  })

  it('returns empty when nothing usable is left, instead of an invalid slug', () => {
    expect(slugify('!!')).toBe('')
    expect(slugify('ab')).toBe('') // under the 3-char minimum
  })

  it('validates slugs the same way the backend does', () => {
    expect(isValidSlug('acme')).toBe(true)
    expect(isValidSlug('acme-corp-1')).toBe(true)
    expect(isValidSlug('-acme')).toBe(false)
    expect(isValidSlug('acme-')).toBe(false)
    expect(isValidSlug('AC')).toBe(false)
    expect(isValidSlug('Acme')).toBe(false)
  })

  it('normalizes an SSO domain to a single leading @, lowercase', () => {
    expect(normalizeDomainInput('Company.COM')).toBe('@company.com')
    expect(normalizeDomainInput('@company.com')).toBe('@company.com')
    expect(normalizeDomainInput('  @@Company.com ')).toBe('@company.com')
    expect(normalizeDomainInput('')).toBe('')
  })
})

describe('billing status', () => {
  it('is Active for a paid, in-period team', () => {
    expect(billingStatusLabel(team())).toBe('Active')
    expect(isTeamBillable(team())).toBe(true)
  })

  it('explains each non-billable state and who fixes it', () => {
    expect(billingStatusLabel(team({ status: 'suspended' }))).toMatch(/suspended/i)
    expect(billingStatusLabel(team({ subscription: null, plan: null }))).toMatch(/No team plan/i)
    expect(
      billingStatusLabel(team({ subscription: { status: 'past_due', currentPeriodEnd: null } })),
    ).toMatch(/past due/i)
    expect(
      billingStatusLabel(team({ subscription: { status: 'canceled', currentPeriodEnd: null } })),
    ).toMatch(/canceled/i)
    expect(
      billingStatusLabel(
        team({ subscription: { status: 'active', currentPeriodEnd: '2000-01-01T00:00:00.000Z' } }),
      ),
    ).toMatch(/period ended/i)
  })

  it('is not billable in any of those states', () => {
    expect(isTeamBillable(team({ status: 'suspended' }))).toBe(false)
    expect(isTeamBillable(team({ subscription: null, plan: null }))).toBe(false)
  })
})

function joinLink(over: Partial<TeamJoinLink> = {}): TeamJoinLink {
  return {
    id: 31,
    url: 'https://rayucode.com/dashboard/team/acme/join/abc',
    role: 'member',
    status: 'active',
    state: 'active',
    expiresAt: '2099-01-01T00:00:00.000Z',
    useCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...over,
  }
}

function preview(over: Partial<JoinLinkPreview> = {}): JoinLinkPreview {
  return {
    team: {
      name: 'Acme',
      slug: 'acme',
      ssoDomain: '@company.com',
      status: 'active',
      memberCount: 3,
    },
    linkStatus: 'active',
    membership: 'none',
    otherTeamSlug: null,
    request: null,
    ...over,
  }
}

describe('purchased team credits', () => {
  function pool(over: Partial<{
    totalCredits: number
    usedCredits: number
    extraCredits: number
  }> = {}) {
    const p = { totalCredits: 1000, usedCredits: 0, extraCredits: 0, ...over }
    return { ...p, remainingCredits: 0, periodEnd: null }
  }

  it('usage is measured against plan + purchased, not the plan alone', () => {
    // 1000 plan + 500 purchased, 1200 spent. Against the plan alone this would
    // read as 120% — a topped-up team must never see a full bar while it still
    // has credits.
    expect(poolUsedPct(pool({ extraCredits: 500, usedCredits: 1200 }))).toBe(80)
    expect(teamAllowance(pool({ extraCredits: 500 }))).toBe(1500)
  })

  it('a payload without purchased credits behaves exactly as before', () => {
    expect(poolUsedPct(pool({ usedCredits: 250 }))).toBe(25)
    expect(teamAllowance(pool())).toBe(1000)
    expect(teamAllowance(null)).toBe(0)
  })

  it('the plan allowance is shown as spent first', () => {
    // Nothing spent: both tiers intact.
    expect(allowanceSplit(pool({ extraCredits: 500 }))).toEqual({
      plan: 1000,
      purchased: 500,
      total: 1500,
    })
    // Inside the plan tier: purchased credits are untouched.
    expect(allowanceSplit(pool({ extraCredits: 500, usedCredits: 400 }))).toEqual({
      plan: 600,
      purchased: 500,
      total: 1100,
    })
    // Past the plan tier: the overflow eats the purchased credits.
    expect(allowanceSplit(pool({ extraCredits: 500, usedCredits: 1200 }))).toEqual({
      plan: 0,
      purchased: 300,
      total: 300,
    })
    // Everything gone — and nothing goes negative.
    expect(allowanceSplit(pool({ extraCredits: 500, usedCredits: 9999 }))).toEqual({
      plan: 0,
      purchased: 0,
      total: 0,
    })
  })

  it('states the expiry in the buyer’s terms', () => {
    expect(creditExpiryLabel(null, null)).toBe('')
    expect(creditExpiryLabel('2026-09-01T00:00:00.000Z', 20)).toMatch(/expires .* \(20 days\)/)
    expect(creditExpiryLabel('2026-09-01T00:00:00.000Z', 1)).toMatch(/\(1 day\)/)
    expect(creditExpiryLabel('2026-09-01T00:00:00.000Z', 0)).toBe('expires today')
  })
})

describe('purchase warning', () => {
  function quote(over: Partial<TeamTopupQuote> = {}): TeamTopupQuote {
    return {
      enabled: true,
      credits: 500,
      amountCents: 10_000,
      currency: 'USD',
      minCredits: 5,
      maxCredits: 100_000_000,
      rateCreditsPerDollar: 5,
      minTopupCents: 100,
      meetsMinimum: true,
      reason: null,
      message: null,
      slug: 'acme',
      planCode: 'team',
      planName: 'Team',
      expiresAt: '2026-09-01T00:00:00.000Z',
      daysLeft: 20,
      expiresSoon: false,
      pool: { totalCredits: 1000, usedCredits: 0, extraCredits: 0 },
      ...over,
    }
  }

  it('says nothing when there is plenty of period left', () => {
    expect(purchaseWarning(quote())).toBeNull()
    expect(purchaseWarning(null)).toBeNull()
  })

  it('warns that credits bought late expire with the period', () => {
    const w = purchaseWarning(quote({ expiresSoon: true, daysLeft: 2 }))
    expect(w).toMatch(/expire in 2 days/)
    // …and points at the thing that actually lasts.
    expect(w).toMatch(/renew or upgrade/i)
  })

  it('is blunter on the last day', () => {
    expect(purchaseWarning(quote({ expiresSoon: true, daysLeft: 0 }))).toMatch(
      /expire today/,
    )
  })

  it('says nothing when the purchase is blocked anyway', () => {
    expect(
      purchaseWarning(
        quote({ enabled: false, reason: 'no_team_plan', expiresSoon: true, daysLeft: 1 }),
      ),
    ).toBeNull()
  })
})

describe('join link label', () => {
  it('tells the admin there is nothing to share yet', () => {
    expect(joinLinkLabel(null)).toMatch(/No join link yet/i)
  })

  it('distinguishes a live link, a dead one, and an expired one', () => {
    expect(joinLinkLabel(joinLink())).toMatch(/^Live ·/)
    expect(joinLinkLabel(joinLink({ state: 'revoked' }))).toMatch(/Turned off/i)
    expect(joinLinkLabel(joinLink({ state: 'expired' }))).toMatch(/Expired/i)
  })

  it('reports the expiry and how far the link has travelled', () => {
    expect(joinLinkLabel(joinLink({ expiresAt: null }))).toMatch(/never expires/)
    expect(joinLinkLabel(joinLink({ useCount: 1 }))).toMatch(/1 request so far/)
    expect(joinLinkLabel(joinLink({ useCount: 4 }))).toMatch(/4 requests so far/)
    expect(joinLinkLabel(joinLink())).toMatch(/not used yet/)
  })
})

describe('join blocked reason', () => {
  it('lets a fresh visitor ask', () => {
    expect(joinBlockedReason(preview())).toBeNull()
  })

  it('explains every state that stops the ask, in the visitor’s terms', () => {
    expect(joinBlockedReason(preview({ linkStatus: 'revoked' }))).toMatch(/turned off/i)
    expect(joinBlockedReason(preview({ linkStatus: 'expired' }))).toMatch(/expired/i)
    expect(joinBlockedReason(preview({ membership: 'member' }))).toMatch(/already a member/i)
    expect(
      joinBlockedReason(preview({ membership: 'other_team', otherTeamSlug: 'other' })),
    ).toMatch(/"other"/)
    expect(
      joinBlockedReason(
        preview({
          request: { id: 1, status: 'pending', createdAt: '', decidedAt: null },
        }),
      ),
    ).toMatch(/waiting for a team admin/i)
  })

  it('a suspended team outranks everything else — nothing can be joined', () => {
    expect(
      joinBlockedReason(
        preview({ team: { ...preview().team, status: 'suspended' }, linkStatus: 'active' }),
      ),
    ).toMatch(/suspended/i)
  })

  it('a rejected request does not block asking again', () => {
    expect(
      joinBlockedReason(
        preview({
          request: { id: 1, status: 'rejected', createdAt: '', decidedAt: '' },
        }),
      ),
    ).toBeNull()
  })
})
