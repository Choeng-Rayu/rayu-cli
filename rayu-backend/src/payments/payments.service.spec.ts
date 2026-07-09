import { BadRequestException } from '@nestjs/common'
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
    payment: { findUnique: Mock; create: Mock; update: Mock; findFirst: Mock }
    creditTopup: { create: Mock; findFirst: Mock; updateMany: Mock }
    subscription: { updateMany: Mock; create: Mock }
    $transaction: Mock
  }
  bakong: { checkPaidByMd5: Mock; generateKhqr: Mock }
  aba: { generateAbaQR: Mock }
  settings: { get: Mock }
  users: { getActiveSubscription: Mock }
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
      findFirst: jest.fn(),
    },
    creditTopup: {
      create: jest.fn(() => Promise.resolve({})),
      findFirst: jest.fn(() => Promise.resolve(null)),
      updateMany: jest.fn(() => Promise.resolve({})),
    },
    subscription: {
      updateMany: jest.fn(() => Promise.resolve({})),
      create: jest.fn(() => Promise.resolve({})),
    },
    // ops are already promises (mocked methods run eagerly) → just await them
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  }
  const bakong = { checkPaidByMd5: jest.fn(), generateKhqr: jest.fn(() => ({ qr: 'BAKONG_QR', md5: 'md5-x' })) }
  const aba = { generateAbaQR: jest.fn(() => 'ABA_QR') }
  const settings = { get: jest.fn(() => Promise.resolve({ topupCentsPer1kCredits: 100 })) }
  // Default: user's effective active plan is Free, so a plan purchase is never
  // blocked as a duplicate unless a test overrides this.
  const users = {
    getActiveSubscription: jest.fn(() =>
      Promise.resolve({ plan: { code: 'free' }, currentPeriodEnd: null }),
    ),
  }
  // Promo service mock — no-op by default (tests that exercise promo override).
  const promo = {
    validateForPurchase: jest.fn(),
    recordPendingRedemption: jest.fn(() => Promise.resolve()),
    finalizeRedemption: jest.fn(() => Promise.resolve()),
    cancelPendingRedemption: jest.fn(() => Promise.resolve()),
  }

  const service = new PaymentsService(
    prisma as unknown as PrismaService,
    bakong as unknown as BakongService,
    aba as unknown as AbaService,
    settings as unknown as AppSettingsService,
    users as unknown as import('../users/users.service').UsersService,
    promo as unknown as import('../promo/promo.service').PromoService,
  )
  return { service, prisma, bakong, aba, settings, users, promo } as unknown as Mocks
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
})
