import { BadRequestException } from '@nestjs/common'
import type { Organization, Plan } from '@prisma/client'
import { PaymentsService } from './payments.service'
import type { AbaService } from './aba.service'
import type { BakongService } from './bakong.service'
import type { OrganizationsService } from '../organizations/organizations.service'
import type { PrismaService } from '../prisma/prisma.service'
import type { AppSettingsService } from '../settings/app-settings.service'
import type { PromoService } from '../promo/promo.service'
import type { UsersService } from '../users/users.service'

/**
 * Team billing: an ORG-owned payment seeds the team's shared credit pool and
 * leaves the paying admin's personal subscription alone. This is the branch that
 * makes "one pay, many users" work, and the assertions below are specifically
 * about what must NOT happen on that path (no individual subscription switch, no
 * carry-over top-up for the payer).
 */

type Mock = jest.Mock

const TEAM_PLAN = {
  id: 3,
  code: 'team',
  name: 'Team',
  priceCents: 5000,
  availability: 'active',
  limits: { creditsPerPeriod: 1000 },
  isTeamPlan: true,
  seatCredits: 0,
} as unknown as Plan

const INDIVIDUAL_PLAN = {
  id: 2,
  code: 'pro',
  name: 'Pro',
  priceCents: 2000,
  availability: 'active',
  limits: { creditsPerPeriod: 500 },
  isTeamPlan: false,
  seatCredits: 0,
} as unknown as Plan

const ORG = {
  id: 21,
  name: 'Acme',
  slug: 'acme',
  adminId: 1,
  status: 'active',
} as unknown as Organization

interface Mocks {
  service: PaymentsService
  prisma: {
    plan: { findUnique: Mock }
    payment: { findUnique: Mock; create: Mock; updateMany: Mock; findFirst: Mock }
    creditTopup: { findFirst: Mock }
    organizationCreditTopup: {
      findFirst: Mock
      create: Mock
      update: Mock
      updateMany: Mock
    }
    organizationSubscription: { findUnique: Mock }
    creditPool: { findUnique: Mock; update: Mock }
    organizationMember: { findFirst: Mock }
    subscription: { findMany: Mock; updateMany: Mock; create: Mock }
    creditLedger: { aggregate: Mock }
    $transaction: Mock
  }
  orgs: { requireAdmin: Mock; activateSubscription: Mock; grantExtraCredits: Mock }
}

/** A team plan that permits pay-as-you-go credits on top of its allowance. */
const TOPUP_PLAN = {
  ...TEAM_PLAN,
  limits: { creditsPerPeriod: 1000, topUpEnabled: true },
} as unknown as Plan

/** An active org subscription on that plan, well inside its period. */
function activeSub(plan: Plan = TOPUP_PLAN, daysLeft = 20) {
  return {
    organizationId: 21,
    status: 'active',
    currentPeriodEnd: new Date(Date.now() + daysLeft * 24 * 60 * 60 * 1000),
    plan,
  }
}

function makeService(): Mocks {
  const prisma: Mocks['prisma'] = {
    plan: { findUnique: jest.fn() },
    payment: {
      findUnique: jest.fn(),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 77, ...data }),
      ),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      findFirst: jest.fn(() => Promise.resolve(null)),
    },
    creditTopup: { findFirst: jest.fn(() => Promise.resolve(null)) },
    organizationCreditTopup: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 91, ...data }),
      ),
      update: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    organizationSubscription: { findUnique: jest.fn(() => Promise.resolve(null)) },
    creditPool: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      update: jest.fn(() => Promise.resolve({})),
    },
    organizationMember: { findFirst: jest.fn(() => Promise.resolve(null)) },
    subscription: {
      findMany: jest.fn(() => Promise.resolve([])),
      updateMany: jest.fn(() => Promise.resolve({})),
      create: jest.fn(() => Promise.resolve({})),
    },
    creditLedger: { aggregate: jest.fn(() => Promise.resolve({ _sum: { credits: 0 } })) },
    // Supports both the array form and the interactive form (the org credit grant
    // uses the latter, because its guard has to decide whether to write at all).
    $transaction: jest.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => Promise<unknown>)(prisma)
        : Promise.all(arg as Promise<unknown>[]),
    ),
  }
  const bakong = {
    checkPaidByMd5: jest.fn(() => Promise.resolve({ paid: true, ref: 'TRX-1' })),
    generateKhqr: jest.fn(() => ({ qr: 'BAKONG_QR', md5: 'md5-team' })),
  }
  const aba = { generateAbaQR: jest.fn(() => 'ABA_QR') }
  const settings = {
    get: jest.fn(() => Promise.resolve({ creditsPerDollar: 5, minTopupCents: 100 })),
  }
  const users = {
    getActiveSubscription: jest.fn(() =>
      Promise.resolve({ plan: { code: 'free' }, currentPeriodEnd: null }),
    ),
    getTopupBalance: jest.fn(() => Promise.resolve(0)),
  }
  const promo = {
    validateForPurchase: jest.fn(),
    recordPendingRedemption: jest.fn(() => Promise.resolve()),
    finalizeRedemption: jest.fn(() => Promise.resolve()),
    cancelPendingRedemption: jest.fn(() => Promise.resolve()),
  }
  const orgs = {
    requireAdmin: jest.fn(() => Promise.resolve(ORG)),
    activateSubscription: jest.fn(() =>
      Promise.resolve({ totalCredits: 1000, members: 4 }),
    ),
    grantExtraCredits: jest.fn(() =>
      Promise.resolve({
        organizationId: 21,
        credits: 500,
        targetUserId: null,
        targetMissing: false,
        extraCredits: 500,
        poolRemaining: 600,
        periodEnd: null,
      }),
    ),
  }

  const service = new PaymentsService(
    prisma as unknown as PrismaService,
    bakong as unknown as BakongService,
    aba as unknown as AbaService,
    settings as unknown as AppSettingsService,
    users as unknown as UsersService,
    promo as unknown as PromoService,
    orgs as unknown as OrganizationsService,
  )
  return { service, prisma, orgs } as unknown as Mocks
}

describe('PaymentsService · team checkout', () => {
  it('creates an org-scoped pending payment for a team plan', async () => {
    const m = makeService()
    m.prisma.plan.findUnique.mockResolvedValue(TEAM_PLAN)

    const res = await m.service.createTeamKhqr(1, 'acme', 'enterprise', 'bakong')

    // Admin rights are checked against the DATABASE, not a JWT claim.
    expect(m.orgs.requireAdmin).toHaveBeenCalledWith('acme', 1)
    const data = m.prisma.payment.create.mock.calls[0][0].data
    expect(data.organizationId).toBe(21) // the switch activatePaid keys off
    expect(data.userId).toBe(1) // the admin still owes the money
    expect(data.amountCents).toBe(5000)
    expect(data.status).toBe('pending')
    expect(res.slug).toBe('acme')
    expect(res.organizationId).toBe(21)
  })

  it('refuses to buy an individual plan for a team', async () => {
    const m = makeService()
    m.prisma.plan.findUnique.mockResolvedValue(INDIVIDUAL_PLAN)
    await expect(
      m.service.createTeamKhqr(1, 'acme', 'pro', 'bakong'),
    ).rejects.toThrow(BadRequestException)
    expect(m.prisma.payment.create).not.toHaveBeenCalled()
  })

  it('reuses a still-valid pending team QR instead of minting a second one', async () => {
    const m = makeService()
    m.prisma.plan.findUnique.mockResolvedValue(TEAM_PLAN)
    m.prisma.payment.findFirst.mockResolvedValue({
      id: 55,
      amountCents: 5000,
      discountCents: 0,
      currency: 'USD',
      khqr: 'OLD_QR',
      md5: 'md5-old',
      expiresAt: new Date(Date.now() + 60_000),
    })

    const res = await m.service.createTeamKhqr(1, 'acme', 'enterprise', 'bakong')

    expect(res.reused).toBe(true)
    expect(res.paymentId).toBe(55)
    expect(m.prisma.payment.create).not.toHaveBeenCalled()
  })
})

describe('PaymentsService · team credit quote', () => {
  it('prices credits at the same rate as an individual, and says when they expire', async () => {
    const m = makeService()
    m.prisma.organizationSubscription.findUnique.mockResolvedValue(activeSub())
    m.prisma.creditPool.findUnique.mockResolvedValue({
      totalCredits: 1000,
      usedCredits: 950,
      extraCredits: 0,
      periodEnd: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
    })

    const q = await m.service.getTeamTopupQuote(1, 'acme', 500)

    expect(m.orgs.requireAdmin).toHaveBeenCalledWith('acme', 1)
    expect(q.enabled).toBe(true)
    expect(q.reason).toBeNull()
    // 500 credits at 5 credits/$ = $100. Same shared math as the individual path.
    expect(q.credits).toBe(500)
    expect(q.amountCents).toBe(10_000)
    expect(q.rateCreditsPerDollar).toBe(5)
    // The buyer must see the expiry BEFORE paying — purchased credits die with
    // the period they were bought into.
    expect(q.daysLeft).toBe(20)
    expect(q.expiresSoon).toBe(false)
    expect(q.pool.extraCredits).toBe(0)
  })

  it('warns when the period is nearly over', async () => {
    const m = makeService()
    m.prisma.organizationSubscription.findUnique.mockResolvedValue(activeSub(TOPUP_PLAN, 2))
    m.prisma.creditPool.findUnique.mockResolvedValue({
      totalCredits: 1000,
      usedCredits: 0,
      extraCredits: 0,
      periodEnd: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    })

    const q = await m.service.getTeamTopupQuote(1, 'acme', 500)

    expect(q.enabled).toBe(true) // still purchasable…
    expect(q.expiresSoon).toBe(true) // …but the UI must say what they are buying
    expect(q.daysLeft).toBe(2)
  })

  it('refuses a team with no plan, and says to buy the plan first', async () => {
    const m = makeService()
    m.prisma.organizationSubscription.findUnique.mockResolvedValue(null)

    const q = await m.service.getTeamTopupQuote(1, 'acme', 500)

    expect(q.enabled).toBe(false)
    expect(q.reason).toBe('no_team_plan')
    expect(q.message).toMatch(/team plan/i)
  })

  it('refuses when the plan itself does not allow buying extra credits', async () => {
    const m = makeService()
    // TEAM_PLAN has no topUpEnabled — the per-plan kill switch, same flag the
    // individual plans use.
    m.prisma.organizationSubscription.findUnique.mockResolvedValue(activeSub(TEAM_PLAN))

    const q = await m.service.getTeamTopupQuote(1, 'acme', 500)

    expect(q.enabled).toBe(false)
    expect(q.reason).toBe('plan_topup_disabled')
    expect(q.message).toMatch(/top-up/i)
  })

  it('refuses a lapsed period rather than selling credits that die immediately', async () => {
    const m = makeService()
    m.prisma.organizationSubscription.findUnique.mockResolvedValue({
      ...activeSub(),
      currentPeriodEnd: new Date(Date.now() - 1000),
    })

    const q = await m.service.getTeamTopupQuote(1, 'acme', 500)

    expect(q.enabled).toBe(false)
    expect(q.reason).toBe('period_ended')
  })

  it('reports the admin rate being off as its own reason', async () => {
    const m = makeService()
    m.prisma.organizationSubscription.findUnique.mockResolvedValue(activeSub())
    const settings = (m.service as unknown as {
      settings: { get: Mock }
    }).settings
    settings.get.mockResolvedValue({ creditsPerDollar: 0, minTopupCents: 100 })

    const q = await m.service.getTeamTopupQuote(1, 'acme', 500)

    expect(q.enabled).toBe(false)
    expect(q.reason).toBe('rate_disabled')
    expect(q.amountCents).toBe(0)
  })
})

describe('PaymentsService · buying team credits', () => {
  function eligible(m: Mocks, daysLeft = 20) {
    m.prisma.organizationSubscription.findUnique.mockResolvedValue(
      activeSub(TOPUP_PLAN, daysLeft),
    )
    m.prisma.creditPool.findUnique.mockResolvedValue({
      totalCredits: 1000,
      usedCredits: 900,
      extraCredits: 0,
      periodEnd: new Date(Date.now() + daysLeft * 24 * 60 * 60 * 1000),
    })
  }

  it('creates an org-scoped payment plus a PENDING credit row — and grants nothing yet', async () => {
    const m = makeService()
    eligible(m)

    const res = await m.service.createTeamTopup(1, 'acme', 500, 'bakong')

    expect(m.orgs.requireAdmin).toHaveBeenCalledWith('acme', 1)
    const payment = m.prisma.payment.create.mock.calls[0][0].data
    expect(payment.organizationId).toBe(21) // the switch activatePaid keys off
    expect(payment.userId).toBe(1) // the admin owes the money
    expect(payment.amountCents).toBe(10_000) // 500 credits at 5/$
    expect(payment.planId).toBeUndefined() // a credit purchase, not a plan
    const topup = m.prisma.organizationCreditTopup.create.mock.calls[0][0].data
    expect(topup).toEqual(
      expect.objectContaining({
        organizationId: 21,
        purchasedById: 1,
        targetUserId: null,
        credits: 500,
        amountCents: 10_000,
        status: 'pending',
        paymentId: 77,
      }),
    )
    // Nothing is spendable until the money lands.
    expect(m.orgs.grantExtraCredits).not.toHaveBeenCalled()
    if (res.method !== 'aba' && res.method !== 'bakong') throw new Error('expected KHQR rail')
    expect(res.qr).toBe('BAKONG_QR')
    expect(res.creditsExpireAt).toBeInstanceOf(Date)
  })

  it('records the target member so the grant can raise their bucket too', async () => {
    const m = makeService()
    eligible(m)
    m.prisma.organizationMember.findFirst.mockResolvedValue({
      id: 4,
      userId: 8,
      status: 'active',
    })

    const res = await m.service.createTeamTopup(1, 'acme', 500, 'bakong', 8)

    expect(
      m.prisma.organizationCreditTopup.create.mock.calls[0][0].data.targetUserId,
    ).toBe(8)
    expect(res.targetUserId).toBe(8)
  })

  it('refuses a target who is not an active member, before taking any money', async () => {
    const m = makeService()
    eligible(m)
    m.prisma.organizationMember.findFirst.mockResolvedValue(null)

    await expect(
      m.service.createTeamTopup(1, 'acme', 500, 'bakong', 999),
    ).rejects.toThrow(BadRequestException)
    expect(m.prisma.payment.create).not.toHaveBeenCalled()
  })

  it('refuses the purchase for the same reasons the quote reports', async () => {
    const m = makeService()
    // No team plan: credits are an add-on, not a substitute.
    m.prisma.organizationSubscription.findUnique.mockResolvedValue(null)

    await expect(m.service.createTeamTopup(1, 'acme', 500)).rejects.toThrow(
      /team plan/i,
    )
    expect(m.prisma.payment.create).not.toHaveBeenCalled()
    expect(m.prisma.organizationCreditTopup.create).not.toHaveBeenCalled()
  })

  it('enforces the dollar floor in the unit the admin chose', async () => {
    const m = makeService()
    eligible(m)
    // 1 credit at 5 credits/$ = 20¢, below the $1 minimum.
    await expect(m.service.createTeamTopup(1, 'acme', 1)).rejects.toThrow(
      /Minimum top-up is \$1\.00 \(5 credits\)/,
    )
    expect(m.prisma.payment.create).not.toHaveBeenCalled()
  })

  it('reuses a pending QR for the same intent instead of minting a second one', async () => {
    const m = makeService()
    eligible(m)
    m.prisma.organizationCreditTopup.findFirst.mockResolvedValue({
      id: 91,
      paymentId: 55,
      credits: 500,
      targetUserId: null,
      status: 'pending',
    })
    m.prisma.payment.findFirst.mockResolvedValue({
      id: 55,
      amountCents: 10_000,
      currency: 'USD',
      khqr: 'OLD_QR',
      md5: 'md5-old',
      expiresAt: new Date(Date.now() + 60_000),
    })

    const res = await m.service.createTeamTopup(1, 'acme', 500, 'bakong')

    expect(res.reused).toBe(true)
    expect(res.paymentId).toBe(55)
    expect(m.prisma.payment.create).not.toHaveBeenCalled()
  })

  it('treats "for the pool" and "for a member" as different pending purchases', async () => {
    const m = makeService()
    eligible(m)
    m.prisma.organizationMember.findFirst.mockResolvedValue({
      id: 4,
      userId: 8,
      status: 'active',
    })

    await m.service.createTeamTopup(1, 'acme', 500, 'bakong', 8)

    // The reuse lookup must be scoped to the target, or buying 500 for Bob would
    // hand back the QR for 500 to the pool.
    expect(m.prisma.organizationCreditTopup.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ credits: 500, targetUserId: 8, status: 'pending' }),
      }),
    )
  })
})

describe('PaymentsService · team credit confirmation', () => {
  const TOPUP_PAYMENT = {
    id: 78,
    userId: 1,
    organizationId: 21,
    planId: null,
    plan: null,
    provider: 'bakong',
    md5: 'md5-credits',
    amountCents: 10_000,
    status: 'pending',
    promoCodeId: null,
    expiresAt: new Date(Date.now() + 60_000),
  }

  function pendingPurchase(over: Record<string, unknown> = {}) {
    return {
      id: 91,
      organizationId: 21,
      credits: 500,
      targetUserId: null,
      status: 'pending',
      ...over,
    }
  }

  it('a confirmed purchase grants the credits to the team pool', async () => {
    const m = makeService()
    m.prisma.payment.findUnique.mockResolvedValue(TOPUP_PAYMENT)
    m.prisma.organizationCreditTopup.findFirst.mockResolvedValue(pendingPurchase())

    const res = (await m.service.checkStatus(78, 1)) as Record<string, unknown>

    expect(res.status).toBe('paid')
    expect(res.kind).toBe('team_topup')
    expect(res.granted).toBe(true)
    expect(m.orgs.grantExtraCredits).toHaveBeenCalledWith(21, 500, null)
    // A credit purchase must never touch the team's SUBSCRIPTION.
    expect(m.orgs.activateSubscription).not.toHaveBeenCalled()
    // Nor the payer's own plan.
    expect(m.prisma.subscription.create).not.toHaveBeenCalled()
  })

  it('is idempotent: a racing second confirmation grants nothing', async () => {
    const m = makeService()
    m.prisma.payment.findUnique.mockResolvedValue(TOPUP_PAYMENT)
    m.prisma.organizationCreditTopup.findFirst.mockResolvedValue(pendingPurchase())
    // The other caller already flipped the row pending -> paid.
    m.prisma.organizationCreditTopup.updateMany.mockResolvedValue({ count: 0 })

    const res = (await m.service.checkStatus(78, 1)) as Record<string, unknown>

    expect(res.status).toBe('paid')
    expect(res.granted).toBe(false)
    // The critical assertion: no second grant, so no credits are minted twice.
    expect(m.orgs.grantExtraCredits).not.toHaveBeenCalled()
    expect(m.prisma.payment.updateMany).not.toHaveBeenCalled()
  })

  it('passes the target member through so their bucket rises too', async () => {
    const m = makeService()
    m.prisma.payment.findUnique.mockResolvedValue(TOPUP_PAYMENT)
    m.prisma.organizationCreditTopup.findFirst.mockResolvedValue(
      pendingPurchase({ targetUserId: 8 }),
    )
    m.orgs.grantExtraCredits.mockResolvedValue({
      organizationId: 21,
      credits: 500,
      targetUserId: 8,
      targetMissing: false,
      extraCredits: 500,
      poolRemaining: 600,
      periodEnd: null,
    })

    const res = (await m.service.checkStatus(78, 1)) as Record<string, unknown>

    expect(m.orgs.grantExtraCredits).toHaveBeenCalledWith(21, 500, 8)
    expect(res.targetUserId).toBe(8)
  })

  it('a target who left the team gets a pool-only grant, recorded on the purchase', async () => {
    const m = makeService()
    m.prisma.payment.findUnique.mockResolvedValue(TOPUP_PAYMENT)
    m.prisma.organizationCreditTopup.findFirst.mockResolvedValue(
      pendingPurchase({ targetUserId: 8 }),
    )
    m.orgs.grantExtraCredits.mockResolvedValue({
      organizationId: 21,
      credits: 500,
      targetUserId: null,
      targetMissing: true,
      extraCredits: 500,
      poolRemaining: 600,
      periodEnd: null,
    })

    const res = (await m.service.checkStatus(78, 1)) as Record<string, unknown>

    // The money moved, so the grant must still land — in the pool.
    expect(res.granted).toBe(true)
    expect(res.targetMissing).toBe(true)
    expect(m.prisma.organizationCreditTopup.update).toHaveBeenCalledWith({
      where: { id: 91 },
      data: { targetUserId: null },
    })
  })

  it('a payment with neither a plan nor a credit purchase is still an error', async () => {
    const m = makeService()
    m.prisma.payment.findUnique.mockResolvedValue(TOPUP_PAYMENT)
    m.prisma.organizationCreditTopup.findFirst.mockResolvedValue(null)

    await expect(m.service.checkStatus(78, 1)).rejects.toThrow(BadRequestException)
  })

  it('a refund claws the credits back out of the pool, floored at zero', async () => {
    const m = makeService()
    m.prisma.organizationCreditTopup.findFirst.mockResolvedValue({
      ...pendingPurchase(),
      status: 'paid',
    })
    // The team already spent more than it bought.
    m.prisma.creditPool.findUnique.mockResolvedValue({
      organizationId: 21,
      totalCredits: 1000,
      usedCredits: 1400,
      extraCredits: 300,
    })

    const res = await m.service.refundTeamTopup(78, 'REV-1')

    expect(res.clawedBack).toBe(true)
    expect(m.prisma.creditPool.update).toHaveBeenCalledWith({
      where: { organizationId: 21 },
      // 300 - 500 would be -200: a negative extra would quietly eat the plan's
      // own allowance, so it clamps.
      data: { extraCredits: 0 },
    })
  })

  it('a replayed refund writes nothing', async () => {
    const m = makeService()
    m.prisma.organizationCreditTopup.findFirst.mockResolvedValue({
      ...pendingPurchase(),
      status: 'refunded',
    })
    m.prisma.organizationCreditTopup.updateMany.mockResolvedValue({ count: 0 })

    const res = await m.service.refundTeamTopup(78)

    expect(res.clawedBack).toBe(false)
    expect(m.prisma.creditPool.update).not.toHaveBeenCalled()
  })
})

describe('PaymentsService · team payment confirmation', () => {
  const ORG_PAYMENT = {
    id: 77,
    userId: 1,
    organizationId: 21,
    planId: TEAM_PLAN.id,
    plan: TEAM_PLAN,
    provider: 'bakong',
    md5: 'md5-team',
    amountCents: 5000,
    status: 'pending',
    promoCodeId: null,
    expiresAt: new Date(Date.now() + 60_000),
  }

  it('seeds the org pool and does NOT touch the payer’s own subscription', async () => {
    const m = makeService()
    m.prisma.payment.findUnique.mockResolvedValue(ORG_PAYMENT)

    const res = (await m.service.checkStatus(77, 1)) as Record<string, unknown>

    expect(m.orgs.activateSubscription).toHaveBeenCalledWith(
      21,
      TEAM_PLAN,
      expect.any(Date),
    )
    // The individual path must be completely untouched for a team purchase.
    expect(m.prisma.subscription.create).not.toHaveBeenCalled()
    expect(m.prisma.subscription.updateMany).not.toHaveBeenCalled()
    expect(res.kind).toBe('team')
    expect(res.poolCredits).toBe(1000)
    expect(res.members).toBe(4)
  })

  it('is idempotent: a second confirmation does not seed the pool again', async () => {
    const m = makeService()
    m.prisma.payment.findUnique.mockResolvedValue(ORG_PAYMENT)
    // Lost the pending -> paid race (another poll/alert already won it).
    m.prisma.payment.updateMany.mockResolvedValue({ count: 0 })

    const res = (await m.service.checkStatus(77, 1)) as Record<string, unknown>

    expect(m.orgs.activateSubscription).not.toHaveBeenCalled()
    expect(res.activated).toBe(true)
    expect(res.kind).toBe('team')
  })

  it('an individual payment still switches the payer’s own subscription', async () => {
    const m = makeService()
    m.prisma.payment.findUnique.mockResolvedValue({
      ...ORG_PAYMENT,
      organizationId: null,
      planId: INDIVIDUAL_PLAN.id,
      plan: INDIVIDUAL_PLAN,
    })

    await m.service.checkStatus(77, 1)

    expect(m.orgs.activateSubscription).not.toHaveBeenCalled()
    expect(m.prisma.subscription.create).toHaveBeenCalled()
  })
})
