import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { Prisma, type PromoCode } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'

export type DiscountType = 'percent' | 'fixed'
export const DISCOUNT_TYPES: readonly DiscountType[] = ['percent', 'fixed']

export interface CreatePromoInput {
  code: string
  description?: string | null
  discountType: DiscountType
  discountValue: number
  /** null / [] = all plans; else the plan codes it applies to. */
  appliesToPlans?: string[] | null
  /** null = unlimited; else the "first N accounts" cap. */
  maxRedemptions?: number | null
  startsAt?: string | Date | null
  endsAt?: string | Date | null
  active?: boolean
}

export type UpdatePromoInput = Partial<CreatePromoInput>

/** Result of pricing a plan with a promo code. */
export interface PromoQuote {
  promo: PromoCode
  originalCents: number
  discountCents: number
  finalCents: number
  /** True when the discount reduces the price to $0 (claim, no payment). */
  isFree: boolean
}

@Injectable()
export class PromoService {
  constructor(private readonly prisma: PrismaService) {}

  /** Codes are matched case-insensitively; stored normalized (trim + lower). */
  normalizeCode(code: string): string {
    return (code ?? '').trim().toLowerCase()
  }

  private parsePlans(promo: PromoCode): string[] {
    const v = promo.appliesToPlans
    return Array.isArray(v) ? (v as string[]) : []
  }

  // --- Admin CRUD -----------------------------------------------------------

  findAll(): Promise<PromoCode[]> {
    return this.prisma.promoCode.findMany({ orderBy: { id: 'desc' } })
  }

  async findOne(id: number): Promise<PromoCode> {
    const promo = await this.prisma.promoCode.findUnique({ where: { id } })
    if (!promo) throw new NotFoundException(`Unknown promo code: ${id}`)
    return promo
  }

  private validateShape(
    discountType: DiscountType,
    discountValue: number,
  ): void {
    if (!DISCOUNT_TYPES.includes(discountType)) {
      throw new BadRequestException('discountType must be percent or fixed')
    }
    if (!Number.isInteger(discountValue) || discountValue < 0) {
      throw new BadRequestException('discountValue must be a non-negative integer')
    }
    if (discountType === 'percent' && discountValue > 100) {
      throw new BadRequestException('percent discountValue must be 0-100')
    }
  }

  async create(input: CreatePromoInput): Promise<PromoCode> {
    const code = this.normalizeCode(input.code)
    if (!code) throw new BadRequestException('code is required')
    this.validateShape(input.discountType, input.discountValue)
    const existing = await this.prisma.promoCode.findUnique({ where: { code } })
    if (existing) throw new BadRequestException(`Promo code "${code}" already exists`)
    return this.prisma.promoCode.create({
      data: {
        code,
        description: input.description ?? null,
        discountType: input.discountType,
        discountValue: input.discountValue,
        appliesToPlans: this.plansToJson(input.appliesToPlans),
        maxRedemptions: input.maxRedemptions ?? null,
        startsAt: this.toDate(input.startsAt),
        endsAt: this.toDate(input.endsAt),
        active: input.active ?? true,
      },
    })
  }

  async update(id: number, patch: UpdatePromoInput): Promise<PromoCode> {
    await this.findOne(id)
    const data: Prisma.PromoCodeUpdateInput = {}
    if (patch.code !== undefined) {
      const code = this.normalizeCode(patch.code)
      if (!code) throw new BadRequestException('code is required')
      const clash = await this.prisma.promoCode.findUnique({ where: { code } })
      if (clash && clash.id !== id) {
        throw new BadRequestException(`Promo code "${code}" already exists`)
      }
      data.code = code
    }
    if (patch.discountType !== undefined || patch.discountValue !== undefined) {
      const current = await this.findOne(id)
      this.validateShape(
        (patch.discountType ?? current.discountType) as DiscountType,
        patch.discountValue ?? current.discountValue,
      )
    }
    if (patch.description !== undefined) data.description = patch.description
    if (patch.discountType !== undefined) data.discountType = patch.discountType
    if (patch.discountValue !== undefined) data.discountValue = patch.discountValue
    if (patch.appliesToPlans !== undefined)
      data.appliesToPlans = this.plansToJson(patch.appliesToPlans)
    if (patch.maxRedemptions !== undefined)
      data.maxRedemptions = patch.maxRedemptions
    if (patch.startsAt !== undefined) data.startsAt = this.toDate(patch.startsAt)
    if (patch.endsAt !== undefined) data.endsAt = this.toDate(patch.endsAt)
    if (patch.active !== undefined) data.active = patch.active
    return this.prisma.promoCode.update({ where: { id }, data })
  }

  async remove(id: number): Promise<{ deleted: true }> {
    await this.findOne(id)
    await this.prisma.promoCode.delete({ where: { id } })
    return { deleted: true }
  }

  /** Admin "apply" (active=true) / "end" (active=false) toggle. */
  async setActive(id: number, active: boolean): Promise<PromoCode> {
    await this.findOne(id)
    return this.prisma.promoCode.update({ where: { id }, data: { active } })
  }

  private plansToJson(
    plans: string[] | null | undefined,
  ): Prisma.InputJsonValue | typeof Prisma.JsonNull {
    if (!plans || plans.length === 0) return Prisma.JsonNull
    return plans as Prisma.InputJsonValue
  }

  private toDate(v: string | Date | null | undefined): Date | null {
    if (v === null || v === undefined || v === '') return null
    const d = v instanceof Date ? v : new Date(v)
    if (Number.isNaN(d.getTime())) throw new BadRequestException('invalid date')
    return d
  }

  // --- Pricing + validation -------------------------------------------------

  /** Pure discount math: percent floors, fixed is capped at the price; final ≥ 0. */
  computeDiscount(
    promo: Pick<PromoCode, 'discountType' | 'discountValue'>,
    originalCents: number,
  ): { discountCents: number; finalCents: number } {
    const base = Math.max(0, Math.round(originalCents))
    let discountCents =
      promo.discountType === 'percent'
        ? Math.floor((base * promo.discountValue) / 100)
        : promo.discountValue
    discountCents = Math.min(Math.max(0, discountCents), base)
    return { discountCents, finalCents: base - discountCents }
  }

  /**
   * Validate a code for a specific user + plan and return the priced quote.
   * Throws BadRequestException with a user-facing reason when invalid. This is
   * shared by the preview endpoint, the discounted-KHQR path, and the $0 claim.
   */
  async validateForPurchase(
    code: string,
    planCode: string,
    userId: number,
    originalCents: number,
  ): Promise<PromoQuote> {
    const normalized = this.normalizeCode(code)
    const promo = await this.prisma.promoCode.findUnique({
      where: { code: normalized },
    })
    if (!promo) throw new BadRequestException('Invalid promo code')
    if (!promo.active) throw new BadRequestException('This promo code is not active')

    const now = Date.now()
    if (promo.startsAt && promo.startsAt.getTime() > now) {
      throw new BadRequestException('This promo code is not active yet')
    }
    if (promo.endsAt && promo.endsAt.getTime() < now) {
      throw new BadRequestException('This promo code has expired')
    }

    const plans = this.parsePlans(promo)
    if (plans.length > 0 && !plans.includes(planCode)) {
      throw new BadRequestException(
        'This promo code cannot be used for the selected plan',
      )
    }

    // One redemption per user: an already-APPLIED redemption blocks reuse; a
    // pending/canceled one is fine (the user is retrying/refreshing checkout).
    const mine = await this.prisma.promoRedemption.findUnique({
      where: { promoCodeId_userId: { promoCodeId: promo.id, userId } },
    })
    if (mine && mine.status === 'applied') {
      throw new BadRequestException('You have already used this promo code')
    }

    // "First N accounts" cap — based on redemptions actually applied. A user who
    // already holds a pending/applied redemption for this code doesn't re-consume
    // a slot on preview.
    if (
      promo.maxRedemptions != null &&
      !mine &&
      promo.usedCount >= promo.maxRedemptions
    ) {
      throw new BadRequestException('This promo code has reached its usage limit')
    }

    const { discountCents, finalCents } = this.computeDiscount(promo, originalCents)
    return {
      promo,
      originalCents: Math.max(0, Math.round(originalCents)),
      discountCents,
      finalCents,
      isFree: finalCents <= 0,
    }
  }

  // --- Redemption lifecycle -------------------------------------------------

  /** Upsert a PENDING redemption for (promo, user) when a discounted QR is issued. */
  async recordPendingRedemption(args: {
    promoCodeId: number
    userId: number
    planCode: string
    originalCents: number
    discountCents: number
    finalCents: number
    paymentId?: number | null
  }): Promise<void> {
    const { promoCodeId, userId, ...rest } = args
    await this.prisma.promoRedemption.upsert({
      where: { promoCodeId_userId: { promoCodeId, userId } },
      create: {
        promoCodeId,
        userId,
        planCode: rest.planCode,
        paymentId: rest.paymentId ?? null,
        originalCents: rest.originalCents,
        discountCents: rest.discountCents,
        finalCents: rest.finalCents,
        status: 'pending',
      },
      update: {
        planCode: rest.planCode,
        paymentId: rest.paymentId ?? null,
        originalCents: rest.originalCents,
        discountCents: rest.discountCents,
        finalCents: rest.finalCents,
        // Reopen a previously-canceled redemption; never downgrade 'applied'.
        status: 'pending',
      },
    })
  }

  /**
   * Finalize a redemption as APPLIED and increment the promo's usedCount ONCE,
   * atomically re-checking the cap so a race can't oversell "first N accounts".
   * No-op if already applied. Called on payment confirmation and $0 claim.
   */
  async finalizeRedemption(
    promoCodeId: number,
    userId: number,
    paymentId?: number | null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const redemption = await tx.promoRedemption.findUnique({
        where: { promoCodeId_userId: { promoCodeId, userId } },
      })
      if (!redemption || redemption.status === 'applied') return
      const promo = await tx.promoCode.findUnique({ where: { id: promoCodeId } })
      if (!promo) return
      if (promo.maxRedemptions != null && promo.usedCount >= promo.maxRedemptions) {
        throw new BadRequestException('This promo code has reached its usage limit')
      }
      await tx.promoCode.update({
        where: { id: promoCodeId },
        data: { usedCount: { increment: 1 } },
      })
      await tx.promoRedemption.update({
        where: { promoCodeId_userId: { promoCodeId, userId } },
        data: {
          status: 'applied',
          ...(paymentId != null ? { paymentId } : {}),
        },
      })
    })
  }

  /** Free the reserved slot when a discounted payment is canceled/expired. */
  async cancelPendingRedemption(
    promoCodeId: number,
    userId: number,
  ): Promise<void> {
    await this.prisma.promoRedemption.updateMany({
      where: { promoCodeId, userId, status: 'pending' },
      data: { status: 'canceled' },
    })
  }
}
