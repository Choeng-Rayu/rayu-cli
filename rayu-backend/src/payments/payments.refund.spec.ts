import { NotFoundException } from '@nestjs/common'
import { PaymentsService } from './payments.service'
import type { PrismaService } from '../prisma/prisma.service'
import type { BakongService } from './bakong.service'
import type { AbaService } from './aba.service'
import type { AppSettingsService } from '../settings/app-settings.service'
import type { OrganizationsService } from '../organizations/organizations.service'

type Mock = jest.Mock

interface Mocks {
  service: PaymentsService
  prisma: {
    plan: { findUnique: Mock }
    payment: {
      findUnique: Mock
      findFirst: Mock
      create: Mock
      update: Mock
      updateMany: Mock
    }
    creditTopup: { findFirst: Mock; create: Mock; updateMany: Mock }
    organizationCreditTopup: { findFirst: Mock; updateMany: Mock }
    creditLedger: { aggregate: Mock; create: Mock }
    subscription: { findFirst: Mock; findMany: Mock; update: Mock; updateMany: Mock; create: Mock }
    user: { findUnique: Mock }
    $transaction: Mock
  }
  bakong: { checkPaidByMd5: Mock; generateKhqr: Mock }
  aba: { generateAbaQR: Mock }
  settings: { get: Mock }
  users: { getActiveSubscription: Mock; getTopupBalance: Mock }
  promo: {
    validateForPurchase: Mock
    recordPendingRedemption: Mock
    finalizeRedemption: Mock
    cancelPendingRedemption: Mock
  }
  stripe: { createCheckoutSession: Mock; successUrl: string; cancelUrl: string }
  orgs: { cancelSubscription: Mock; activateSubscription: Mock; grantExtraCredits: Mock }
}

function makeService(withOrgs = true): Mocks {
  // Forward-declared so the $transaction mock can pass the same prisma object
  // to interactive-callback callers (refundTeamTopup uses the callback form so
  // its pending-guard and pool decrement land in one transaction).
  const prisma = {
    plan: { findUnique: jest.fn() },
    payment: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 42, ...data }),
      ),
      update: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    creditTopup: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      create: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    organizationCreditTopup: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      updateMany: jest.fn(() => Promise.resolve({ count: 0 })),
    },
    creditLedger: {
      aggregate: jest.fn(() => Promise.resolve({ _sum: { credits: 0 } })),
      create: jest.fn(() => Promise.resolve({})),
    },
    creditPool: { findUnique: jest.fn(() => Promise.resolve(null)), update: jest.fn(() => Promise.resolve({})) },
    subscription: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      findMany: jest.fn(() => Promise.resolve([])),
      update: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({})),
      create: jest.fn(() => Promise.resolve({})),
    },
    user: { findUnique: jest.fn(() => Promise.resolve(null)) },
    // Supports BOTH the array form (Promise.all) and the interactive callback
    // form (refundTeamTopup uses a callback so its pending-guard and pool
    // decrement are in one transaction).
    $transaction: jest.fn(),
  } as unknown as Mocks['prisma']
  prisma.$transaction.mockImplementation(
    (arg: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) =>
      Array.isArray(arg) ? Promise.all(arg) : arg(prisma),
  )
  const bakong = {
    checkPaidByMd5: jest.fn(),
    generateKhqr: jest.fn(() => ({ qr: 'BAKONG_QR', md5: 'md5-x' })),
  }
  const aba = { generateAbaQR: jest.fn(() => 'ABA_QR') }
  const settings = { get: jest.fn(() => Promise.resolve({ creditsPerDollar: 5, minTopupCents: 100 })) }
  const users = {
    getActiveSubscription: jest.fn(() => Promise.resolve({ plan: { code: 'free' } })),
    getTopupBalance: jest.fn(() => Promise.resolve(0)),
  }
  const promo = {
    validateForPurchase: jest.fn(),
    recordPendingRedemption: jest.fn(() => Promise.resolve()),
    finalizeRedemption: jest.fn(() => Promise.resolve()),
    cancelPendingRedemption: jest.fn(() => Promise.resolve()),
  }
  const stripe = {
    createCheckoutSession: jest.fn(() =>
      Promise.resolve({
        id: 'cs_test_123',
        url: 'https://checkout.stripe.com/c/pay/cs_test_123',
        paymentIntentId: 'pi_test_123',
      }),
    ),
    successUrl: 'https://rayu.test/billing/success',
    cancelUrl: 'https://rayu.test/billing/cancel',
  }
  const orgs = {
    cancelSubscription: jest.fn(() => Promise.resolve({ organizationId: 1, status: 'canceled' })),
    activateSubscription: jest.fn(() => Promise.resolve({ totalCredits: 0, members: 0 })),
    grantExtraCredits: jest.fn(() =>
      Promise.resolve({
        organizationId: 1,
        credits: 0,
        targetUserId: null,
        targetMissing: false,
        extraCredits: 0,
        poolRemaining: 0,
        periodEnd: null,
      }),
    ),
  }
  const service = new PaymentsService(
    prisma as unknown as PrismaService,
    bakong as unknown as BakongService,
    aba as unknown as AbaService,
    settings as unknown as AppSettingsService,
    users as unknown as import('../users/users.service').UsersService,
    promo as unknown as import('../promo/promo.service').PromoService,
    (withOrgs ? orgs : undefined) as unknown as OrganizationsService,
    stripe as unknown as import('./stripe/stripe.service').StripeService,
  )
  return { service, prisma, bakong, aba, settings, users, promo, stripe, orgs } as unknown as Mocks
}

describe('PaymentsService · expireStripeCheckout', () => {
  it('no-ops (200) when no row exists for the session id', async () => {
    const m = makeService()
    m.prisma.payment.findUnique.mockResolvedValue(null)
    const res = await m.service.expireStripeCheckout('cs_unknown')
    expect(res).toEqual({ paymentId: null, status: 'unknown' })
    expect(m.prisma.payment.update).not.toHaveBeenCalled()
  })

  it('no-ops when the row is already in a terminal status (paid)', async () => {
    const m = makeService()
    m.prisma.payment.findUnique.mockResolvedValue({
      id: 5,
      status: 'paid',
      expiresAt: null,
      plan: null,
    })
    const res = await m.service.expireStripeCheckout('cs_paid')
    expect(res.status).toBe('paid')
    expect(m.prisma.payment.update).not.toHaveBeenCalled()
  })

  it('expires a pending row + its linked top-up + frees the promo slot', async () => {
    const m = makeService()
    m.prisma.payment.findUnique.mockResolvedValue({
      id: 5,
      userId: 1,
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
      promoCodeId: 99,
      plan: null,
    })
    const res = await m.service.expireStripeCheckout('cs_pending')
    expect(res.status).toBe('expired')
    expect(m.prisma.payment.update).toHaveBeenCalled()
    expect(m.prisma.creditTopup.updateMany).toHaveBeenCalled()
    expect(m.promo.cancelPendingRedemption).toHaveBeenCalledWith(99, 1)
  })
})

describe('PaymentsService · handleChargeRefunded', () => {
  it('throws NotFound when no payment row exists for the id', async () => {
    const m = makeService()
    m.prisma.payment.findUnique.mockResolvedValue(null)
    await expect(m.service.handleChargeRefunded(404, 'pi_x')).rejects.toBeInstanceOf(
      NotFoundException,
    )
  })

  it('routes an individual top-up to refundTopup', async () => {
    const m = makeService()
    m.prisma.payment.findUnique.mockResolvedValue({
      id: 7,
      userId: 1,
      organizationId: null,
      planId: null,
      plan: null,
    })
    m.prisma.creditTopup.findFirst.mockResolvedValue({
      id: 9,
      userId: 1,
      credits: 25,
      status: 'paid',
      paymentId: 7,
    })
    const res = await m.service.handleChargeRefunded(7, 'pi_topup')
    expect(res.handled).toBe('topup')
    expect(m.users.getTopupBalance).toHaveBeenCalled()
    expect(m.orgs.cancelSubscription).not.toHaveBeenCalled()
  })

  it('routes a team credit purchase to refundTeamTopup', async () => {
    const m = makeService()
    m.prisma.payment.findUnique.mockResolvedValue({
      id: 8,
      userId: 1,
      organizationId: 21,
      planId: null,
      plan: null,
    })
    m.prisma.creditTopup.findFirst.mockResolvedValue(null)
    m.prisma.organizationCreditTopup.findFirst.mockResolvedValue({
      id: 11,
      organizationId: 21,
      credits: 500,
      status: 'paid',
      paymentId: 8,
    })
    const res = await m.service.handleChargeRefunded(8, 'pi_teamtopup')
    expect(res.handled).toBe('team_topup')
    expect(m.orgs.cancelSubscription).not.toHaveBeenCalled()
  })

  it('routes a team plan purchase to OrganizationsService.cancelSubscription', async () => {
    const m = makeService()
    m.prisma.payment.findUnique.mockResolvedValue({
      id: 9,
      userId: 1,
      organizationId: 21,
      planId: 7,
      plan: { id: 7, code: 'team' },
    })
    m.prisma.creditTopup.findFirst.mockResolvedValue(null)
    m.prisma.organizationCreditTopup.findFirst.mockResolvedValue(null)
    const res = await m.service.handleChargeRefunded(9, 'pi_teamplan')
    expect(res.handled).toBe('team_plan')
    expect(m.orgs.cancelSubscription).toHaveBeenCalledWith(21)
  })

  it('cancels an individual plan subscription ONLY when the active sub matches this payment', async () => {
    const m = makeService()
    const paidAt = new Date(Date.now() - 60_000)
    const startedAt = new Date(Date.now() - 30_000)
    m.prisma.payment.findUnique.mockResolvedValue({
      id: 10,
      userId: 1,
      organizationId: null,
      planId: 7,
      paidAt,
      plan: { id: 7, code: 'pro' },
    })
    m.prisma.creditTopup.findFirst.mockResolvedValue(null)
    m.prisma.subscription.findFirst.mockResolvedValue({
      id: 3,
      userId: 1,
      planId: 7,
      status: 'active',
      startedAt,
    })
    const res = await m.service.handleChargeRefunded(10, 'pi_plan')
    expect(res.handled).toBe('individual_plan')
    expect(m.prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: { status: 'canceled' },
    })
  })

  it('does NOT cancel when the active subscription is for a different plan', async () => {
    const m = makeService()
    m.prisma.payment.findUnique.mockResolvedValue({
      id: 11,
      userId: 1,
      organizationId: null,
      planId: 7,
      paidAt: new Date(),
      plan: { id: 7, code: 'pro' },
    })
    m.prisma.creditTopup.findFirst.mockResolvedValue(null)
    // The user has since upgraded to a different plan — must not be canceled.
    m.prisma.subscription.findFirst.mockResolvedValue({
      id: 4,
      userId: 1,
      planId: 8,
      status: 'active',
      startedAt: new Date(),
    })
    const res = await m.service.handleChargeRefunded(11, 'pi_plan')
    expect(res.handled).toBe('individual_plan')
    expect(m.prisma.subscription.update).not.toHaveBeenCalled()
    // Refund still recorded on the payment row.
    expect(m.prisma.payment.updateMany).toHaveBeenCalledWith({
      where: { id: 11, status: 'paid' },
      data: { status: 'refunded' },
    })
  })

  it('does NOT cancel when the active subscription started BEFORE this payment was paid', async () => {
    const m = makeService()
    const paidAt = new Date(Date.now() - 60_000)
    // The active sub started a day before this payment was paid — this payment
    // did not activate it (it was a re-buy / a duplicate), so leave it alone.
    const startedAt = new Date(Date.now() - 24 * 60 * 60 * 1000)
    m.prisma.payment.findUnique.mockResolvedValue({
      id: 12,
      userId: 1,
      organizationId: null,
      planId: 7,
      paidAt,
      plan: { id: 7, code: 'pro' },
    })
    m.prisma.creditTopup.findFirst.mockResolvedValue(null)
    m.prisma.subscription.findFirst.mockResolvedValue({
      id: 5,
      userId: 1,
      planId: 7,
      status: 'active',
      startedAt,
    })
    const res = await m.service.handleChargeRefunded(12, 'pi_plan')
    expect(res.handled).toBe('individual_plan')
    expect(m.prisma.subscription.update).not.toHaveBeenCalled()
  })

  it('is idempotent — a replayed refund finds no active sub to cancel and no paid row to flip', async () => {
    const m = makeService()
    m.prisma.payment.findUnique.mockResolvedValue({
      id: 13,
      userId: 1,
      organizationId: null,
      planId: 7,
      paidAt: new Date(),
      plan: { id: 7, code: 'pro' },
      status: 'refunded', // already refunded on the first delivery
    })
    m.prisma.creditTopup.findFirst.mockResolvedValue(null)
    m.prisma.subscription.findFirst.mockResolvedValue(null) // already canceled
    // The updateMany guards on status='paid' → count 0 on the replay.
    m.prisma.payment.updateMany.mockResolvedValue({ count: 0 })
    const res = await m.service.handleChargeRefunded(13, 'pi_replay')
    expect(res.handled).toBe('individual_plan')
    expect(m.prisma.subscription.update).not.toHaveBeenCalled()
  })

  it('handles a payment with nothing to reverse (no topup, no plan) gracefully', async () => {
    const m = makeService()
    m.prisma.payment.findUnique.mockResolvedValue({
      id: 14,
      userId: 1,
      organizationId: null,
      planId: null,
      plan: null,
    })
    m.prisma.creditTopup.findFirst.mockResolvedValue(null)
    const res = await m.service.handleChargeRefunded(14, 'pi_x')
    expect(res.handled).toBe('nothing')
  })
})

describe('PaymentsService · order independence (refund before completion)', () => {
  it('a refund that lands while the payment is still pending no-ops and the later completion grants', async () => {
    const m = makeService()
    // Payment still pending — the completion event has not arrived yet.
    m.prisma.payment.findUnique.mockResolvedValue({
      id: 20,
      userId: 1,
      organizationId: null,
      planId: 7,
      paidAt: null,
      plan: { id: 7, code: 'pro' },
      status: 'pending',
    })
    m.prisma.creditTopup.findFirst.mockResolvedValue({
      id: 21,
      userId: 1,
      credits: 25,
      status: 'pending', // not yet paid → refundTopup guard finds nothing to flip
      paymentId: 20,
    })
    // refundTopup guards on status='paid' → count 0, no clawback.
    m.prisma.creditTopup.updateMany.mockResolvedValueOnce({ count: 0 })
    m.prisma.payment.updateMany.mockResolvedValueOnce({ count: 0 })
    const res = await m.service.handleChargeRefunded(20, 'pi_early')
    expect(res.handled).toBe('topup')
    // No clawback happened (the grant hadn't landed yet).
    expect(m.prisma.creditLedger.create).not.toHaveBeenCalled()
  })
})