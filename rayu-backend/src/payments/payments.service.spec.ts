import {
  BadRequestException,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common'
import { PaymentsService } from './payments.service'
import type { PrismaService } from '../prisma/prisma.service'
import type { BakongService } from './bakong.service'
import type { AbaService } from './aba.service'
import type { AppSettingsService } from '../settings/app-settings.service'

const THIRTY_MIN = 30 * 60 * 1000

type Mock = jest.Mock

interface Mocks {
  service: PaymentsService
  prisma: {
    plan: { findUnique: Mock }
    payment: { findUnique: Mock; create: Mock; update: Mock; updateMany: Mock; findFirst: Mock }
    creditTopup: { create: Mock; findFirst: Mock; updateMany: Mock }
    organizationCreditTopup: { findFirst: Mock; update: Mock; updateMany: Mock }
    creditLedger: { aggregate: Mock; create: Mock }
    subscription: { findMany: Mock; updateMany: Mock; create: Mock }
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
  stripe: {
    createCheckoutSession: Mock
    retrieveSession: Mock
    expireSession: Mock
    constructWebhookEvent: Mock
  }
}

/**
 * Turn the card rail on for the duration of one test.
 *
 * The rail is env-gated (stripe.config.isStripeEnabled reads process.env on every
 * call), so a test that wants the enabled path must set the flag and — critically —
 * clear it again, or it leaks into every test that runs after it and silently
 * changes which branch of requireStripe() they take. Returns a restore function
 * rather than relying on afterEach so the enabling is visible at the call site.
 */
function withStripeEnabled(): () => void {
  const previous = process.env.STRIPE_ENABLED
  process.env.STRIPE_ENABLED = 'true'
  return () => {
    if (previous === undefined) delete process.env.STRIPE_ENABLED
    else process.env.STRIPE_ENABLED = previous
  }
}

function makeService(): Mocks {
  const prisma = {
    plan: { findUnique: jest.fn() },
    payment: {
      findUnique: jest.fn(),
      // echo the passed data + a fresh id so callers see what was persisted
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 42, ...data }),
      ),
      update: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      findFirst: jest.fn(),
    },
    creditTopup: {
      create: jest.fn(() => Promise.resolve({})),
      findFirst: jest.fn(() => Promise.resolve(null)),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    // Team credit purchases live in their own table; the individual lifecycle
    // paths (expire/cancel/renew) touch it so an abandoned team QR cannot stay
    // 'pending' and be handed back on the next attempt.
    organizationCreditTopup: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      update: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 0 })),
    },
    creditLedger: {
      aggregate: jest.fn(() => Promise.resolve({ _sum: { credits: 0 } })),
      create: jest.fn(() => Promise.resolve({})),
    },
    subscription: {
      findMany: jest.fn(() => Promise.resolve([])),
      updateMany: jest.fn(() => Promise.resolve({})),
      create: jest.fn(() => Promise.resolve({})),
    },
    // billingEmail() reads the user's email to prefill Stripe Checkout. Default
    // to null — the path is best-effort and must never be fatal to a purchase.
    user: { findUnique: jest.fn(() => Promise.resolve(null)) },
    // ops are already promises (mocked methods run eagerly) → just await them
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  }
  const bakong = { checkPaidByMd5: jest.fn(), generateKhqr: jest.fn(() => ({ qr: 'BAKONG_QR', md5: 'md5-x' })) }
  const aba = { generateAbaQR: jest.fn(() => 'ABA_QR') }
  // Default top-up config: $1 buys 5 credits, minimum purchase $1.
  const settings = {
    get: jest.fn(() => Promise.resolve({ creditsPerDollar: 5, minTopupCents: 100 })),
  }
  // Default: user's effective active plan is Free, so a plan purchase is never
  // blocked as a duplicate unless a test overrides this.
  const users = {
    getActiveSubscription: jest.fn(() =>
      Promise.resolve({ plan: { code: 'free' }, currentPeriodEnd: null }),
    ),
    // Mirrors the real reader: granted (paid topups) − consumed (ledger
    // source='topup'), clamped at 0. Tests override to assert the clamp.
    getTopupBalance: jest.fn(() => Promise.resolve(0)),
  }
  // Promo service mock — no-op by default (tests that exercise promo override).
  const promo = {
    validateForPurchase: jest.fn(),
    recordPendingRedemption: jest.fn(() => Promise.resolve()),
    finalizeRedemption: jest.fn(() => Promise.resolve()),
    cancelPendingRedemption: jest.fn(() => Promise.resolve()),
  }
  // Card rail mock. Stands in for the SDK wrapper only — it has no business logic
  // to mock, because every pricing and grant rule lives in PaymentsService. The
  // URL properties are plain values (not jest.fn) because attachCheckout reads
  // them as getters on the real service.
  const stripe = {
    createCheckoutSession: jest.fn(() =>
      Promise.resolve({
        id: 'cs_test_123',
        url: 'https://checkout.stripe.com/c/pay/cs_test_123',
        paymentIntentId: 'pi_test_123',
      }),
    ),
    retrieveSession: jest.fn(),
    expireSession: jest.fn(() => Promise.resolve()),
    constructWebhookEvent: jest.fn(),
    successUrl: 'https://rayu.test/billing/success',
    cancelUrl: 'https://rayu.test/billing/cancel',
  }

  const service = new PaymentsService(
    prisma as unknown as PrismaService,
    bakong as unknown as BakongService,
    aba as unknown as AbaService,
    settings as unknown as AppSettingsService,
    users as unknown as import('../users/users.service').UsersService,
    promo as unknown as import('../promo/promo.service').PromoService,
    // orgs — individual-billing tests do not need the team service.
    undefined,
    stripe as unknown as import('./stripe/stripe.service').StripeService,
  )
  return { service, prisma, bakong, aba, settings, users, promo, stripe } as unknown as Mocks
}

describe('PaymentsService · KHQR expiry lifecycle', () => {
  describe('createKhqr', () => {
    it('creates a pending payment with a ~30-minute expiresAt and returns it', async () => {
      const m = makeService()
      m.prisma.plan.findUnique.mockResolvedValue({
        id: 7,
        code: 'pro',
        availability: 'active',
        priceCents: 1000,
      })

      const before = Date.now()
      const res = await m.service.createKhqr(1, 'pro', 'bakong')

      const createArg = m.prisma.payment.create.mock.calls[0][0]
      expect(createArg.data.status).toBe('pending')
      const expMs = (createArg.data.expiresAt as Date).getTime()
      expect(expMs).toBeGreaterThanOrEqual(before + THIRTY_MIN - 1000)
      expect(expMs).toBeLessThanOrEqual(Date.now() + THIRTY_MIN + 1000)
      expect(res.expiresAt).toBeInstanceOf(Date)
    })

    it('reuses an existing pending, non-expired QR instead of minting a new one (refresh)', async () => {
      const m = makeService()
      m.prisma.plan.findUnique.mockResolvedValue({
        id: 7,
        code: 'pro',
        availability: 'active',
        priceCents: 1000,
        limits: { creditsPerPeriod: 50 },
      })
      // A live pending payment already exists for this user+plan+method.
      m.prisma.payment.findFirst.mockResolvedValue({
        id: 99,
        amountCents: 1000,
        currency: 'USD',
        khqr: 'EXISTING_QR',
        md5: 'existing-md5',
        expiresAt: new Date(Date.now() + 20 * 60_000),
      })

      const res = await m.service.createKhqr(1, 'pro', 'bakong')

      expect(res.reused).toBe(true)
      expect(res.paymentId).toBe(99)
      if (res.method !== 'aba' && res.method !== 'bakong') throw new Error('expected KHQR rail')
      expect(res.qr).toBe('EXISTING_QR')
      expect(m.prisma.payment.create).not.toHaveBeenCalled()
    })

    it('blocks a duplicate purchase of an already-active non-credit plan (basic)', async () => {
      const m = makeService()
      m.prisma.plan.findUnique.mockResolvedValue({
        id: 2,
        code: 'basic',
        name: 'Basic',
        availability: 'active',
        priceCents: 300,
        limits: { features: {} }, // no creditsPerPeriod → feature-unlock plan
      })
      m.users.getActiveSubscription.mockResolvedValue({
        plan: { code: 'basic' },
        currentPeriodEnd: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
      })

      await expect(m.service.createKhqr(1, 'basic', 'bakong')).rejects.toBeInstanceOf(
        BadRequestException,
      )
      expect(m.prisma.payment.create).not.toHaveBeenCalled()
    })

    it('allows re-buying a credit plan the user already holds (not blocked)', async () => {
      const m = makeService()
      m.prisma.plan.findUnique.mockResolvedValue({
        id: 7,
        code: 'pro',
        availability: 'active',
        priceCents: 1000,
        limits: { creditsPerPeriod: 50 },
      })
      // Even though the user is already on pro, a credit plan is re-purchasable.
      m.users.getActiveSubscription.mockResolvedValue({
        plan: { code: 'pro' },
        currentPeriodEnd: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
      })
      m.prisma.payment.findFirst.mockResolvedValue(null) // no reusable pending

      const res = await m.service.createKhqr(1, 'pro', 'bakong')
      expect(res.reused).toBe(false)
      expect(m.prisma.payment.create).toHaveBeenCalled()
    })
  })

  describe('cancelPayment', () => {
    it('cancels a pending payment (+ marks it canceled)', async () => {
      const m = makeService()
      m.prisma.payment.findUnique.mockResolvedValue({
        id: 42,
        userId: 1,
        status: 'pending',
        provider: 'bakong',
        plan: { code: 'pro' },
        expiresAt: new Date(),
      })

      const res = await m.service.cancelPayment(42, 1)

      expect(res.status).toBe('canceled')
      const updateArg = m.prisma.payment.update.mock.calls[0][0]
      expect(updateArg.data.status).toBe('canceled')
    })

    it('rejects canceling an already-paid payment', async () => {
      const m = makeService()
      m.prisma.payment.findUnique.mockResolvedValue({
        id: 42,
        userId: 1,
        status: 'paid',
        provider: 'bakong',
        plan: { code: 'pro' },
      })
      await expect(m.service.cancelPayment(42, 1)).rejects.toBeInstanceOf(
        BadRequestException,
      )
      expect(m.prisma.payment.update).not.toHaveBeenCalled()
    })
  })

  describe('checkStatus', () => {
    const base = {
      id: 42,
      userId: 1,
      md5: 'md5-x',
      provider: 'bakong',
      status: 'pending',
      plan: { code: 'pro' },
    }

    it('expires a stale pending Bakong payment once past the deadline (unpaid)', async () => {
      const m = makeService()
      m.prisma.payment.findUnique.mockResolvedValue({
        ...base,
        expiresAt: new Date(Date.now() - 60_000), // expired 1 min ago
      })
      m.bakong.checkPaidByMd5.mockResolvedValue({ paid: false })

      const res = await m.service.checkStatus(42, 1)

      expect(res.status).toBe('expired')
      expect(res.activated).toBe(false)
      const updateArg = m.prisma.payment.update.mock.calls[0][0]
      expect(updateArg.data.status).toBe('expired')
    })

    it('still activates a just-in-time Bakong payment even after the deadline', async () => {
      const m = makeService()
      m.prisma.payment.findUnique.mockResolvedValue({
        ...base,
        planId: 7,
        expiresAt: new Date(Date.now() - 60_000),
      })
      m.bakong.checkPaidByMd5.mockResolvedValue({ paid: true, ref: 'TRX1' })

      const res = await m.service.checkStatus(42, 1)

      expect(res.status).toBe('paid')
      expect(res.activated).toBe(true)
      // subscription switched, not expired
      expect(m.prisma.subscription.create).toHaveBeenCalled()
    })

    it('expires a stale pending ABA payment without polling Bakong', async () => {
      const m = makeService()
      m.prisma.payment.findUnique.mockResolvedValue({
        ...base,
        provider: 'aba',
        md5: 'ABA-abc',
        expiresAt: new Date(Date.now() - 60_000),
      })

      const res = await m.service.checkStatus(42, 1)

      expect(res.status).toBe('expired')
      expect(m.bakong.checkPaidByMd5).not.toHaveBeenCalled()
    })

    it('keeps a not-yet-expired pending payment pending', async () => {
      const m = makeService()
      m.prisma.payment.findUnique.mockResolvedValue({
        ...base,
        provider: 'aba',
        md5: 'ABA-abc',
        expiresAt: new Date(Date.now() + 10 * 60_000), // 10 min left
      })

      const res = await m.service.checkStatus(42, 1)

      expect(res.status).toBe('pending')
      expect(m.prisma.payment.update).not.toHaveBeenCalled()
    })
  })

  describe('renewPayment', () => {
    it('rejects renewing an already-paid payment', async () => {
      const m = makeService()
      m.prisma.payment.findUnique.mockResolvedValue({
        id: 42,
        userId: 1,
        status: 'paid',
        provider: 'bakong',
        plan: { code: 'pro' },
      })
      await expect(m.service.renewPayment(42, 1)).rejects.toBeInstanceOf(
        BadRequestException,
      )
    })

    it('expires the old unpaid row and creates a fresh plan QR', async () => {
      const m = makeService()
      m.prisma.payment.findUnique.mockResolvedValue({
        id: 42,
        userId: 1,
        status: 'expired',
        provider: 'bakong',
        planId: 7,
        plan: { code: 'pro' },
      })
      m.prisma.creditTopup.findFirst.mockResolvedValue(null)
      m.prisma.plan.findUnique.mockResolvedValue({
        id: 7,
        code: 'pro',
        availability: 'active',
        priceCents: 1000,
      })

      const res = await m.service.renewPayment(42, 1)

      if (res.method !== 'aba' && res.method !== 'bakong') throw new Error('expected KHQR rail')
      expect(res.qr).toBe('BAKONG_QR')
      expect(res.paymentId).toBe(42) // mock create echoes id 42
      expect(res.expiresAt).toBeInstanceOf(Date)
    })
  })

  describe('confirmAbaPaymentByAmount', () => {
    it('matches a non-expired pending ABA payment by amount and activates it', async () => {
      const m = makeService()
      m.prisma.payment.findFirst.mockResolvedValue({
        id: 42,
        userId: 1,
        status: 'pending',
        provider: 'aba',
        planId: 7,
        plan: { code: 'pro' },
      })

      const ok = await m.service.confirmAbaPaymentByAmount(10, 'TRX9')

      expect(ok).toBe(true)
      const where = m.prisma.payment.findFirst.mock.calls[0][0].where
      expect(where.provider).toBe('aba')
      expect(where.status).toBe('pending')
      expect(where.amountCents).toBe(1000)
      // matches by the expiry deadline (with grace), not a createdAt heuristic
      expect(where.expiresAt.gte).toBeInstanceOf(Date)
      expect(m.prisma.subscription.create).toHaveBeenCalled()
    })

    it('returns false when no pending payment matches', async () => {
      const m = makeService()
      m.prisma.payment.findFirst.mockResolvedValue(null)
      expect(await m.service.confirmAbaPaymentByAmount(10, 'TRX9')).toBe(false)
    })
  })

  describe('carry-over credits on paid plan activation', () => {
    function abaPayment(planCode: string, planId: number) {
      return {
        id: 42,
        userId: 1,
        status: 'pending',
        provider: 'aba',
        planId,
        plan: { code: planCode },
      }
    }

    function previousSub(creditsPerPeriod: number, startedAtDaysAgo: number, currentPeriodEndDaysFromNow: number) {
      const now = Date.now()
      return {
        id: 1,
        startedAt: new Date(now - startedAtDaysAgo * 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(now + currentPeriodEndDaysFromNow * 24 * 60 * 60 * 1000),
        plan: { limits: { creditsPerPeriod } },
      }
    }

    it('grants unused credits when upgrading mid-period', async () => {
      const m = makeService()
      m.prisma.payment.findFirst.mockResolvedValue(abaPayment('pro_plus', 8))
      m.prisma.subscription.findMany.mockResolvedValue([previousSub(50, 10, 20)])
      m.prisma.creditLedger.aggregate.mockResolvedValue({ _sum: { credits: 30 } })

      const ok = await m.service.confirmAbaPaymentByAmount(20, 'TRX10')

      expect(ok).toBe(true)
      expect(m.prisma.creditTopup.create).toHaveBeenCalled()
      const topupData = m.prisma.creditTopup.create.mock.calls[0][0].data
      expect(topupData.credits).toBe(20)
      expect(topupData.amountCents).toBe(0)
      expect(topupData.status).toBe('paid')
    })

    it('grants unused credits on same-plan renewal', async () => {
      const m = makeService()
      m.prisma.payment.findFirst.mockResolvedValue(abaPayment('pro', 7))
      m.prisma.subscription.findMany.mockResolvedValue([previousSub(50, 15, 15)])
      m.prisma.creditLedger.aggregate.mockResolvedValue({ _sum: { credits: 40 } })

      await m.service.confirmAbaPaymentByAmount(10, 'TRX11')

      const topupData = m.prisma.creditTopup.create.mock.calls[0][0].data
      expect(topupData.credits).toBe(10)
    })

    it('grants no carry-over when prior plan is free', async () => {
      const m = makeService()
      m.prisma.payment.findFirst.mockResolvedValue(abaPayment('pro', 7))
      m.prisma.subscription.findMany.mockResolvedValue([
        {
          id: 1,
          startedAt: new Date(),
          currentPeriodEnd: null,
          plan: { limits: { creditsPerPeriod: null } },
        },
      ])

      await m.service.confirmAbaPaymentByAmount(10, 'TRX12')

      expect(m.prisma.creditTopup.create).not.toHaveBeenCalled()
    })

    it('grants the full allowance as carry-over when no plan credits were used', async () => {
      const m = makeService()
      m.prisma.payment.findFirst.mockResolvedValue(abaPayment('pro_plus', 8))
      m.prisma.subscription.findMany.mockResolvedValue([previousSub(50, 5, 25)])
      m.prisma.creditLedger.aggregate.mockResolvedValue({ _sum: { credits: 0 } })

      await m.service.confirmAbaPaymentByAmount(20, 'TRX13')

      const topupData = m.prisma.creditTopup.create.mock.calls[0][0].data
      expect(topupData.credits).toBe(50)
    })

    it('grants no carry-over when the prior period has already expired', async () => {
      const m = makeService()
      m.prisma.payment.findFirst.mockResolvedValue(abaPayment('pro', 7))
      m.prisma.subscription.findMany.mockResolvedValue([
        {
          id: 1,
          startedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
          currentPeriodEnd: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
          plan: { limits: { creditsPerPeriod: 50 } },
        },
      ])
      m.prisma.creditLedger.aggregate.mockResolvedValue({ _sum: { credits: 10 } })

      await m.service.confirmAbaPaymentByAmount(10, 'TRX14')

      expect(m.prisma.creditTopup.create).not.toHaveBeenCalled()
    })

    it('is idempotent: a second activation of the same payment does not duplicate subscriptions or top-ups', async () => {
      const m = makeService()
      m.prisma.payment.findFirst.mockResolvedValue(abaPayment('pro_plus', 8))
      m.prisma.subscription.findMany.mockResolvedValue([previousSub(50, 10, 20)])
      m.prisma.creditLedger.aggregate.mockResolvedValue({ _sum: { credits: 30 } })
      // First call wins; second call sees count===0.
      m.prisma.payment.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 })

      const ok1 = await m.service.confirmAbaPaymentByAmount(20, 'TRX15')
      const ok2 = await m.service.confirmAbaPaymentByAmount(20, 'TRX15')

      expect(ok1).toBe(true)
      expect(ok2).toBe(true)
      expect(m.prisma.subscription.create).toHaveBeenCalledTimes(1)
      expect(m.prisma.creditTopup.create).toHaveBeenCalledTimes(1)
    })
  })

  describe('claimFreePromo carry-over', () => {
    function promoQuote() {
      return {
        isFree: true,
        promo: { id: 99, code: 'FREE100' },
        originalCents: 1000,
        discountCents: 1000,
        finalCents: 0,
      }
    }

    function previousSub(creditsPerPeriod: number, startedAtDaysAgo: number, currentPeriodEndDaysFromNow: number) {
      const now = Date.now()
      return {
        id: 1,
        startedAt: new Date(now - startedAtDaysAgo * 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(now + currentPeriodEndDaysFromNow * 24 * 60 * 60 * 1000),
        plan: { limits: { creditsPerPeriod } },
      }
    }

    it('carries over unused credits when claiming a new plan with a free promo', async () => {
      const m = makeService()
      m.prisma.plan.findUnique.mockResolvedValue({
        id: 8,
        code: 'pro_plus',
        availability: 'active',
        priceCents: 2000,
        limits: { creditsPerPeriod: 115 },
      })
      m.promo.validateForPurchase.mockResolvedValue(promoQuote())
      m.prisma.subscription.findMany.mockResolvedValue([previousSub(50, 10, 20)])
      m.prisma.creditLedger.aggregate.mockResolvedValue({ _sum: { credits: 20 } })

      const res = await m.service.claimFreePromo(1, 'pro_plus' as any, 'FREE100')

      expect(res.activated).toBe(true)
      expect(res.claimed).toBe(true)
      expect(res.carryoverCredits).toBe(30)
      expect(m.prisma.creditTopup.create).toHaveBeenCalled()
      const topupData = m.prisma.creditTopup.create.mock.calls[0][0].data
      expect(topupData.credits).toBe(30)
      expect(topupData.amountCents).toBe(0)
      expect(topupData.status).toBe('paid')
    })

    it('grants no carry-over when claiming from a free plan', async () => {
      const m = makeService()
      m.prisma.plan.findUnique.mockResolvedValue({
        id: 7,
        code: 'pro',
        availability: 'active',
        priceCents: 1000,
        limits: { creditsPerPeriod: 50 },
      })
      m.promo.validateForPurchase.mockResolvedValue(promoQuote())
      m.prisma.subscription.findMany.mockResolvedValue([])

      const res = await m.service.claimFreePromo(1, 'pro' as any, 'FREE100')

      expect(res.carryoverCredits).toBe(0)
      expect(m.prisma.creditTopup.create).not.toHaveBeenCalled()
    })
  })
})

describe('PaymentsService · credit top-up pricing', () => {
  it('prices a top-up from creditsPerDollar', async () => {
    const m = makeService()
    // $1 = 5 credits ⇒ 25 credits = $5.00.
    const res = await m.service.createTopupKhqr(7, 25, 'bakong')
    expect(res.amountCents).toBe(500)
    expect(res.credits).toBe(25)
    const payment = m.prisma.payment.create.mock.calls[0][0].data as { amountCents: number }
    expect(payment.amountCents).toBe(500)
  })

  it('rounds the price UP so credits are never given away', async () => {
    const m = makeService()
    m.settings.get.mockResolvedValue({ creditsPerDollar: 3, minTopupCents: 1 })
    // 5 credits at 3/$ = $1.6667 → 167¢, not 166¢.
    const res = await m.service.createTopupKhqr(7, 5, 'bakong')
    expect(res.amountCents).toBe(167)
  })

  it('refuses a purchase below the minimum and says what the minimum is', async () => {
    const m = makeService()
    // 2 credits at 5/$ = 40¢, below the $1 floor.
    await expect(m.service.createTopupKhqr(7, 2, 'bakong')).rejects.toThrow(
      /Minimum top-up is \$1\.00 \(5 credits\)/,
    )
    expect(m.prisma.payment.create).not.toHaveBeenCalled()
  })

  it('accepts exactly the minimum', async () => {
    const m = makeService()
    const res = await m.service.createTopupKhqr(7, 5, 'bakong')
    expect(res.amountCents).toBe(100)
  })

  it('is unavailable while the rate is 0', async () => {
    const m = makeService()
    m.settings.get.mockResolvedValue({ creditsPerDollar: 0, minTopupCents: 100 })
    await expect(m.service.createTopupKhqr(7, 5000, 'bakong')).rejects.toThrow(
      BadRequestException,
    )
  })
})

describe('PaymentsService · getTopupQuote', () => {
  it('quotes from the LIVE rate — a mid-session admin change re-prices', async () => {
    const m = makeService()
    // Default fixture: $1 = 5 credits.
    const first = await m.service.getTopupQuote(25)
    expect(first.amountCents).toBe(500)
    expect(first.rateCreditsPerDollar).toBe(5)

    // Admin halves the credits per dollar → same credits now cost twice as much.
    m.settings.get.mockResolvedValue({ creditsPerDollar: 2.5, minTopupCents: 100 })
    const second = await m.service.getTopupQuote(25)
    expect(second.amountCents).toBe(1000)
    expect(second.rateCreditsPerDollar).toBe(2.5)
  })

  it('creates NO payment row — it is a pure quote', async () => {
    const m = makeService()
    await m.service.getTopupQuote(25)
    expect(m.prisma.payment.create).not.toHaveBeenCalled()
    expect(m.prisma.creditTopup.create).not.toHaveBeenCalled()
  })

  it('derives minCredits from minTopupCents at the live rate', async () => {
    const m = makeService()
    const q = await m.service.getTopupQuote(25)
    // $1 floor at 5 credits/$ ⇒ 5 credits.
    expect(q.minCredits).toBe(5)
    expect(q.minTopupCents).toBe(100)

    // Raise the floor to $2 ⇒ 10 credits at the same rate. Never cached across
    // a settings change.
    m.settings.get.mockResolvedValue({ creditsPerDollar: 5, minTopupCents: 200 })
    expect((await m.service.getTopupQuote(25)).minCredits).toBe(10)
  })

  it('clamps a below-minimum request up to minCredits and flags it', async () => {
    const m = makeService()
    const q = await m.service.getTopupQuote(2)
    expect(q.meetsMinimum).toBe(false)
    expect(q.credits).toBe(5)
    expect(q.amountCents).toBe(100)
  })

  it('defaults to the cheapest payable purchase when no amount is asked for', async () => {
    const m = makeService()
    const q = await m.service.getTopupQuote()
    expect(q.credits).toBe(5)
    expect(q.amountCents).toBe(100)
    expect(q.enabled).toBe(true)
  })

  it('reports enabled=false (not a $0 price) while the rate is 0', async () => {
    const m = makeService()
    m.settings.get.mockResolvedValue({ creditsPerDollar: 0, minTopupCents: 100 })
    const q = await m.service.getTopupQuote(5000)
    expect(q.enabled).toBe(false)
    expect(q.amountCents).toBe(0)
    expect(q.minCredits).toBe(0)
    expect(q.rateCreditsPerDollar).toBe(0)
  })

  it('quotes the same price the create path charges (no rail divergence)', async () => {
    const m = makeService()
    const q = await m.service.getTopupQuote(37)
    const created = await m.service.createTopupPayment(7, 37, 'bakong')
    expect(created.amountCents).toBe(q.amountCents)
  })
})

describe('PaymentsService · createTopupPayment rails', () => {
  it('prices ABA and Bakong identically — one shared pricing path', async () => {
    const aba = await makeService().service.createTopupPayment(7, 25, 'aba')
    const bakong = await makeService().service.createTopupPayment(7, 25, 'bakong')
    expect(aba.amountCents).toBe(500)
    expect(bakong.amountCents).toBe(500)
    expect(aba.method).toBe('aba')
    expect(bakong.method).toBe('bakong')
  })

  it('answers 501 for the card rail while Stripe is not enabled', async () => {
    const m = makeService()
    delete process.env.STRIPE_ENABLED
    await expect(m.service.createTopupPayment(7, 25, 'stripe')).rejects.toThrow(
      NotImplementedException,
    )
    // No half-created purchase left behind, and no silent KHQR fallback.
    expect(m.prisma.payment.create).not.toHaveBeenCalled()
    expect(m.prisma.creditTopup.create).not.toHaveBeenCalled()
  })

  it('answers 501 when the config says enabled but the rail provider is missing', async () => {
    // Construct the service WITHOUT the stripe provider, but WITH the env flag on —
    // simulates a wiring bug where StripeService was not registered in the module.
    const m = makeService()
    const restore = withStripeEnabled()
    try {
      const broken = new PaymentsService(
        m.prisma as unknown as PrismaService,
        m.bakong as unknown as BakongService,
        m.aba as unknown as AbaService,
        m.settings as unknown as AppSettingsService,
        m.users as unknown as import('../users/users.service').UsersService,
        m.promo as unknown as import('../promo/promo.service').PromoService,
      )
      await expect(broken.createTopupPayment(7, 25, 'stripe')).rejects.toThrow(
        NotImplementedException,
      )
    } finally {
      restore()
    }
  })

  it('refuses below-minimum amount before ever calling the Stripe SDK', async () => {
    const m = makeService()
    const restore = withStripeEnabled()
    try {
      m.settings.get.mockResolvedValue({ creditsPerDollar: 5, minTopupCents: 200 })
      await expect(m.service.createTopupPayment(7, 1, 'stripe')).rejects.toThrow(
        BadRequestException,
      )
      // Fail-before-touch: the Stripe SDK is NEVER called for a price-floor
      // rejection — not for a Checkout Session and not for a signature check.
      expect(m.stripe.createCheckoutSession).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('returns a checkoutUrl + pending rows when the card rail is enabled', async () => {
    const m = makeService()
    const restore = withStripeEnabled()
    try {
      const result = await m.service.createTopupPayment(7, 25, 'stripe')
      expect(result.method).toBe('stripe')
      if (result.method !== 'stripe') throw new Error('expected stripe rail')
      expect(result.checkoutUrl).toBe('https://checkout.stripe.com/c/pay/cs_test_123')
      expect(result.reused).toBe(false)
      // Both rows created.
      expect(m.prisma.payment.create).toHaveBeenCalled()
      expect(m.prisma.creditTopup.create).toHaveBeenCalled()
      // Checkout was attached (session stamped onto the payment row).
      expect(m.prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            stripeCheckoutSessionId: expect.any(String),
            stripeCheckoutUrl: expect.any(String),
            stripePaymentIntentId: expect.any(String),
          }),
        }),
      )
    } finally {
      restore()
    }
  })

  it('reuses a still-valid pending session on refresh (same credits + method)', async () => {
    const m = makeService()
    const restore = withStripeEnabled()
    try {
      // First call creates everything.
      const first = await m.service.createTopupPayment(7, 25, 'stripe')
      expect(first.reused).toBe(false)

      // Simulate the first payment row existing with a stored URL — the state a
      // second attempt (refresh) sees.
      m.prisma.creditTopup.findFirst.mockResolvedValue({
        id: 99,
        paymentId: 42,
        userId: 7,
        credits: 25,
        status: 'pending',
      })
      m.prisma.payment.findFirst.mockResolvedValue({
        id: 42,
        provider: 'stripe',
        status: 'pending',
        amountCents: 500,
        currency: 'USD',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000), // still valid
        stripeCheckoutUrl: 'https://checkout.stripe.com/c/pay/existing',
      })

      const second = await m.service.createTopupPayment(7, 25, 'stripe')
      expect(second.reused).toBe(true)
      if (second.method !== 'stripe') throw new Error('expected stripe rail')
      expect(second.checkoutUrl).toBe('https://checkout.stripe.com/c/pay/existing')
      // No new rows and no second session.
      expect(m.prisma.payment.create).toHaveBeenCalledTimes(1)
      expect(m.stripe.createCheckoutSession).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })

  it('never reuses a row whose checkout URL is NULL (failed session creation)', async () => {
    const m = makeService()
    const restore = withStripeEnabled()
    try {
      m.prisma.creditTopup.findFirst.mockResolvedValue({
        id: 99,
        paymentId: 42,
        userId: 7,
        credits: 25,
        status: 'pending',
      })
      // The payment row exists but the session stamp never landed — the first
      // attachCheckout crashed before the UPDATE, so the URL column is NULL.
      m.prisma.payment.findFirst.mockResolvedValue({
        id: 42,
        provider: 'stripe',
        status: 'pending',
        amountCents: 500,
        currency: 'USD',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        stripeCheckoutUrl: null, // ← orphan row
      })

      // Reset call counts to isolate the reuse attempt.
      m.prisma.payment.create.mockClear()
      m.stripe.createCheckoutSession.mockClear()

      await m.service.createTopupPayment(7, 25, 'stripe')
      // A new payment row and a new session were created — the orphan was ignored.
      expect(m.prisma.payment.create).toHaveBeenCalledTimes(1)
      expect(m.stripe.createCheckoutSession).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })

  it('rejects every rail while the rate is 0', async () => {
    for (const method of ['aba', 'bakong', 'stripe'] as const) {
      const m = makeService()
      m.settings.get.mockResolvedValue({ creditsPerDollar: 0, minTopupCents: 100 })
      await expect(m.service.createTopupPayment(7, 5000, method)).rejects.toThrow(
        BadRequestException,
      )
    }
  })
})

describe('PaymentsService · top-up grant (activatePaid)', () => {
  /** A paid-at-the-gateway Bakong top-up payment, reached via checkStatus. */
  function pendingTopupPayment(m: Mocks): void {
    m.prisma.payment.findUnique.mockResolvedValue({
      id: 42,
      userId: 7,
      provider: 'bakong',
      md5: 'md5-x',
      status: 'pending',
      expiresAt: new Date(Date.now() + THIRTY_MIN),
      plan: null,
      planId: null,
      promoCodeId: null,
    })
    m.bakong.checkPaidByMd5.mockResolvedValue({ paid: true, ref: 'TRX1' })
    m.prisma.creditTopup.findFirst.mockResolvedValue({
      id: 9,
      userId: 7,
      credits: 25,
      status: 'pending',
      paymentId: 42,
    })
  }

  it('grants by flipping the topup row to paid — the balance both readers sum', async () => {
    const m = makeService()
    pendingTopupPayment(m)

    const res = await m.service.checkStatus(42, 7)

    expect(res).toMatchObject({ status: 'paid', activated: true, credits: 25 })
    // The grant is the pending → paid flip, guarded on status so it can only
    // happen once.
    expect(m.prisma.creditTopup.updateMany).toHaveBeenCalledWith({
      where: { id: 9, status: 'pending' },
      data: { status: 'paid' },
    })
    // Deliberately NO positive ledger row: credit_ledger source='topup' means
    // CONSUMPTION to both balance readers, so writing one here would cancel the
    // grant it was meant to record.
    expect(m.prisma.creditLedger.create).not.toHaveBeenCalled()
  })

  it('grants exactly once under concurrent activation (updateMany count guard)', async () => {
    const m = makeService()
    pendingTopupPayment(m)
    // Simulate the race: the first pending → paid flip wins (count 1), the
    // second finds nothing left to flip (count 0).
    let calls = 0
    m.prisma.payment.updateMany.mockImplementation(() =>
      Promise.resolve({ count: ++calls === 1 ? 1 : 0 }),
    )

    const [first, second] = await Promise.all([
      m.service.checkStatus(42, 7),
      m.service.checkStatus(42, 7),
    ])

    // Both callers observe the paid state...
    expect(first).toMatchObject({ status: 'paid', activated: true })
    expect(second).toMatchObject({ status: 'paid', activated: true })
    // ...but only one of them performed the grant.
    const granted = [first, second].filter(
      (r) => (r as { granted?: boolean }).granted === true,
    )
    expect(granted).toHaveLength(1)
  })
})

describe('PaymentsService · refund clawback', () => {
  function paidTopup(m: Mocks): void {
    m.prisma.creditTopup.findFirst.mockResolvedValue({
      id: 9,
      userId: 7,
      credits: 25,
      status: 'paid',
      paymentId: 42,
    })
  }

  it('claws back by dropping the topup out of paid, and audits it as source=refund', async () => {
    const m = makeService()
    paidTopup(m)

    const res = await m.service.refundTopup(42, 'REFUND-1')

    expect(res.clawedBack).toBe(true)
    // The clawback is visible to the gateway through the SAME column the grant
    // used: a non-'paid' row drops out of the granted SUM.
    expect(m.prisma.creditTopup.updateMany).toHaveBeenCalledWith({
      where: { id: 9, status: 'paid' },
      data: { status: 'refunded' },
    })
    // Audit row is source='refund', NOT 'topup' — 'topup' would be counted as
    // consumption and subtract the credits a second time.
    const ledgerArg = m.prisma.creditLedger.create.mock.calls[0][0] as {
      data: { source: string; credits: number; userId: number }
    }
    expect(ledgerArg.data).toMatchObject({ source: 'refund', credits: 25, userId: 7 })
  })

  it('clamps the balance at 0 instead of going negative when the credits were already spent', async () => {
    const m = makeService()
    paidTopup(m)
    // The reader clamps; assert the clawback reports the clamped balance.
    m.users.getTopupBalance.mockResolvedValue(0)

    const res = await m.service.refundTopup(42)

    expect(res.topupBalance).toBe(0)
    expect(res.topupBalance).toBeGreaterThanOrEqual(0)
  })

  it('is idempotent: a replayed refund event writes no second audit row', async () => {
    const m = makeService()
    paidTopup(m)
    // Already refunded → nothing left in 'paid' to flip.
    m.prisma.creditTopup.updateMany.mockResolvedValue({ count: 0 })

    const res = await m.service.refundTopup(42)

    expect(res.clawedBack).toBe(false)
    expect(m.prisma.creditLedger.create).not.toHaveBeenCalled()
  })

  it('rejects a refund for a payment that is not a top-up', async () => {
    const m = makeService()
    m.prisma.creditTopup.findFirst.mockResolvedValue(null)
    await expect(m.service.refundTopup(42)).rejects.toThrow(NotFoundException)
  })
})
