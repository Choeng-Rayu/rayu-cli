import { PromoService } from './promo.service'
import type { PrismaService } from '../prisma/prisma.service'

// Unit tests for the promo pricing + validation logic (the parts that don't
// need a live DB). Prisma is mocked to the two reads validateForPurchase does.
function makeService(
  overrides: { promo?: unknown; redemption?: unknown } = {},
) {
  const prisma = {
    promoCode: {
      findUnique: jest.fn(() => Promise.resolve(overrides.promo ?? null)),
    },
    promoRedemption: {
      findUnique: jest.fn(() => Promise.resolve(overrides.redemption ?? null)),
    },
  }
  return { service: new PromoService(prisma as unknown as PrismaService), prisma }
}

const promoRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  code: 'rayu-cli',
  description: null,
  discountType: 'percent',
  discountValue: 50,
  appliesToPlans: null,
  maxRedemptions: null,
  usedCount: 0,
  startsAt: null,
  endsAt: null,
  active: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
})

describe('PromoService.computeDiscount (pure math)', () => {
  const { service } = makeService()

  test('percent floors and clamps at the price', () => {
    expect(service.computeDiscount({ discountType: 'percent', discountValue: 50 }, 300)).toEqual({ discountCents: 150, finalCents: 150 })
    expect(service.computeDiscount({ discountType: 'percent', discountValue: 100 }, 300)).toEqual({ discountCents: 300, finalCents: 0 })
    expect(service.computeDiscount({ discountType: 'percent', discountValue: 33 }, 1000)).toEqual({ discountCents: 330, finalCents: 670 })
  })

  test('fixed is capped at the price and never negative', () => {
    expect(service.computeDiscount({ discountType: 'fixed', discountValue: 500 }, 300)).toEqual({ discountCents: 300, finalCents: 0 })
    expect(service.computeDiscount({ discountType: 'fixed', discountValue: 100 }, 300)).toEqual({ discountCents: 100, finalCents: 200 })
  })
})

describe('PromoService.validateForPurchase', () => {
  test('valid percent code returns a priced quote', async () => {
    const { service } = makeService({ promo: promoRow({ discountValue: 50 }) })
    const q = await service.validateForPurchase('RAYU-CLI', 'pro', 7, 1000) // case-insensitive
    expect(q.discountCents).toBe(500)
    expect(q.finalCents).toBe(500)
    expect(q.isFree).toBe(false)
  })

  test('fixed $5-off for all plans, capped at a cheaper plan price → free', async () => {
    const { service } = makeService({ promo: promoRow({ discountType: 'fixed', discountValue: 500 }) })
    const q = await service.validateForPurchase('rayu-cli', 'basic', 7, 300)
    expect(q.discountCents).toBe(300)
    expect(q.finalCents).toBe(0)
    expect(q.isFree).toBe(true)
  })

  test('100%-off marks the quote free (claim path)', async () => {
    const { service } = makeService({ promo: promoRow({ discountValue: 100 }) })
    const q = await service.validateForPurchase('rayu-cli', 'pro', 7, 1000)
    expect(q.finalCents).toBe(0)
    expect(q.isFree).toBe(true)
  })

  test('per-plan code applies for a listed plan', async () => {
    const { service } = makeService({ promo: promoRow({ appliesToPlans: ['pro', 'max'], discountValue: 25 }) })
    const q = await service.validateForPurchase('rayu-cli', 'max', 7, 1000)
    expect(q.discountCents).toBe(250)
  })

  test('rejects: unknown, inactive, not-started, expired, wrong plan, cap reached, already used', async () => {
    await expect(makeService({ promo: null }).service
      .validateForPurchase('nope', 'pro', 7, 1000)).rejects.toThrow(/Invalid promo code/)

    await expect(makeService({ promo: promoRow({ active: false }) }).service
      .validateForPurchase('rayu-cli', 'pro', 7, 1000)).rejects.toThrow(/not active/)

    await expect(makeService({ promo: promoRow({ startsAt: new Date(Date.now() + 86400000) }) }).service
      .validateForPurchase('rayu-cli', 'pro', 7, 1000)).rejects.toThrow(/not active yet/)

    await expect(makeService({ promo: promoRow({ endsAt: new Date(Date.now() - 86400000) }) }).service
      .validateForPurchase('rayu-cli', 'pro', 7, 1000)).rejects.toThrow(/expired/)

    await expect(makeService({ promo: promoRow({ appliesToPlans: ['pro'] }) }).service
      .validateForPurchase('rayu-cli', 'basic', 7, 300)).rejects.toThrow(/cannot be used for the selected plan/)

    await expect(makeService({ promo: promoRow({ maxRedemptions: 100, usedCount: 100 }) }).service
      .validateForPurchase('rayu-cli', 'pro', 7, 1000)).rejects.toThrow(/usage limit/)

    await expect(makeService({ promo: promoRow({}), redemption: { status: 'applied' } }).service
      .validateForPurchase('rayu-cli', 'pro', 7, 1000)).rejects.toThrow(/already used/)
  })

  test('a user with a PENDING (not applied) redemption can still preview (retry/refresh)', async () => {
    const { service } = makeService({ promo: promoRow({ maxRedemptions: 100, usedCount: 100 }), redemption: { status: 'pending' } })
    // mine exists → the cap check is skipped for this already-holding user.
    const q = await service.validateForPurchase('rayu-cli', 'pro', 7, 1000)
    expect(q.finalCents).toBe(500)
  })
})
