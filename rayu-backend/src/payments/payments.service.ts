import { randomUUID } from 'node:crypto'
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type { Payment, Plan } from '@prisma/client'
import type { PlanCode } from '../common/enums'
import { PrismaService } from '../prisma/prisma.service'
import { AppSettingsService } from '../settings/app-settings.service'
import { UsersService } from '../users/users.service'
import { AbaService } from './aba.service'
import { BakongService } from './bakong.service'

export type PaymentMethod = 'aba' | 'bakong'

/**
 * KHQR / pending-payment lifetime. After this the QR is treated as expired and
 * the payment row is transitioned to 'expired'; the user must generate a fresh
 * QR (POST /payments/:id/renew or a new create call).
 */
const KHQR_TTL_MINUTES = 30
const KHQR_TTL_MS = KHQR_TTL_MINUTES * 60 * 1000
/**
 * Extra window (beyond expiry) during which an out-of-band ABA credit alert is
 * still matched to a pending payment — covers the lag between the customer
 * actually paying (before the deadline) and ABA's Telegram alert posting.
 */
const ABA_MATCH_GRACE_MS = 10 * 60 * 1000

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bakong: BakongService,
    private readonly aba: AbaService,
    private readonly settings: AppSettingsService,
    private readonly users: UsersService,
  ) {}

  /** A plan is credit-based when it grants a per-period credit allowance. */
  private isCreditPlan(plan: Plan): boolean {
    const limits = (plan.limits ?? {}) as { creditsPerPeriod?: number | null }
    return (
      typeof limits.creditsPerPeriod === 'number' && limits.creditsPerPeriod > 0
    )
  }

  async createKhqr(
    userId: number,
    planCode: PlanCode,
    method: PaymentMethod = 'aba',
  ) {
    const plan = await this.prisma.plan.findUnique({ where: { code: planCode } })
    if (!plan) throw new NotFoundException('Plan not found')
    if (plan.availability !== 'active' || plan.priceCents <= 0) {
      throw new BadRequestException('Plan is not purchasable')
    }

    // Block a duplicate purchase of a non-credit (feature-unlock) plan the user
    // already actively holds. getActiveSubscription resolves the EFFECTIVE plan
    // (an expired period auto-falls back to Free), so a same-code match here
    // means the subscription is active AND not expired. Credit plans
    // (creditsPerPeriod > 0) are exempt — re-buying renews their period/credits.
    if (!this.isCreditPlan(plan)) {
      const { plan: current } = await this.users.getActiveSubscription(userId)
      if (current.code === plan.code) {
        throw new BadRequestException(
          `You're already on the ${plan.name} plan. It unlocks all features and has no credits to add, so there's nothing to purchase again until it expires.`,
        )
      }
    }

    // Reuse a still-valid pending QR so refreshing the checkout page keeps the
    // SAME QR until it is paid, canceled, or expires (30 min) — instead of
    // minting a brand-new QR on every page load.
    const reusable = await this.prisma.payment.findFirst({
      where: {
        userId,
        planId: plan.id,
        provider: method,
        status: 'pending',
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    })
    if (reusable?.khqr && reusable.md5) {
      return {
        paymentId: reusable.id,
        planCode,
        amountCents: reusable.amountCents,
        currency: reusable.currency,
        method,
        qr: reusable.khqr,
        md5: reusable.md5,
        expiresAt: reusable.expiresAt,
        reused: true,
      }
    }

    const amountUsd = plan.priceCents / 100
    const billNumber = `RAYU-${userId}-${Date.now()}`
    const { qr, md5, provider } = this.buildQr(method, amountUsd, billNumber)

    const payment = await this.prisma.payment.create({
      data: {
        userId,
        planId: plan.id,
        provider,
        amountCents: plan.priceCents,
        currency: 'USD',
        status: 'pending',
        md5,
        khqr: qr,
        expiresAt: new Date(Date.now() + KHQR_TTL_MS),
      },
    })

    return {
      paymentId: payment.id,
      planCode,
      amountCents: plan.priceCents,
      currency: 'USD',
      method,
      qr,
      md5,
      expiresAt: payment.expiresAt,
      reused: false,
    }
  }

  /**
   * Create a pay-as-you-go top-up KHQR. The USD price is derived from the
   * admin-configured topupCentsPer1kCredits rate. Creates a pending payment +
   * a pending credit_topups row linked by paymentId; the credits are granted
   * when the payment is confirmed (Bakong: checkStatus; ABA: Telegram userbot).
   */
  async createTopupKhqr(
    userId: number,
    credits: number,
    method: PaymentMethod = 'aba',
  ) {
    const settings = await this.settings.get()
    const ratePer1k = settings.topupCentsPer1kCredits
    if (!ratePer1k || ratePer1k <= 0) {
      throw new BadRequestException('Top-up is not available')
    }
    const amountCents = Math.ceil((credits / 1000) * ratePer1k)
    if (amountCents <= 0) {
      throw new BadRequestException('Top-up amount too small')
    }

    // Reuse a still-valid pending top-up QR on refresh (same intent = same
    // credit amount + method), mirroring the plan-checkout behavior.
    const existingTopup = await this.prisma.creditTopup.findFirst({
      where: { userId, credits, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    })
    if (existingTopup?.paymentId) {
      const reusable = await this.prisma.payment.findFirst({
        where: {
          id: existingTopup.paymentId,
          provider: method,
          status: 'pending',
          expiresAt: { gt: new Date() },
        },
      })
      if (reusable?.khqr && reusable.md5) {
        return {
          paymentId: reusable.id,
          credits,
          amountCents: reusable.amountCents,
          currency: reusable.currency,
          method,
          qr: reusable.khqr,
          md5: reusable.md5,
          expiresAt: reusable.expiresAt,
          reused: true,
        }
      }
    }

    const billNumber = `RAYU-TOPUP-${userId}-${Date.now()}`
    const { qr, md5, provider } = this.buildQr(
      method,
      amountCents / 100,
      billNumber,
    )

    const payment = await this.prisma.payment.create({
      data: {
        userId,
        provider,
        amountCents,
        currency: 'USD',
        status: 'pending',
        md5,
        khqr: qr,
        expiresAt: new Date(Date.now() + KHQR_TTL_MS),
      },
    })
    await this.prisma.creditTopup.create({
      data: { userId, credits, amountCents, status: 'pending', paymentId: payment.id },
    })

    return { paymentId: payment.id, credits, amountCents, currency: 'USD', method, qr, md5, expiresAt: payment.expiresAt, reused: false }
  }

  /**
   * Build the QR + md5 + provider for the chosen method.
   * - bakong: dynamic KHQR via the Bakong SDK; md5 is checked against ABA later.
   * - aba: dynamic KHQR derived from the static ABA merchant QR. There is no API
   *   to poll, so we mark the row with provider='aba' and an `ABA-` md5 sentinel;
   *   confirmation arrives out-of-band via the Telegram credit-alert listener.
   */
  private buildQr(
    method: PaymentMethod,
    amountUsd: number,
    billNumber: string,
  ): { qr: string; md5: string; provider: PaymentMethod } {
    if (method === 'aba') {
      const qr = this.aba.generateAbaQR(amountUsd, KHQR_TTL_MINUTES)
      return { qr, md5: `ABA-${randomUUID()}`, provider: 'aba' }
    }
    const { qr, md5 } = this.bakong.generateKhqr(amountUsd, billNumber, KHQR_TTL_MS)
    return { qr, md5, provider: 'bakong' }
  }

  async checkStatus(paymentId: number, userId: number) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { plan: true },
    })
    if (!payment) throw new NotFoundException('Payment not found')
    if (payment.userId !== userId) throw new ForbiddenException()

    if (payment.status !== 'pending') {
      return {
        paymentId: payment.id,
        status: payment.status,
        planCode: payment.plan?.code ?? null,
        activated: payment.status === 'paid',
        expiresAt: payment.expiresAt,
      }
    }

    // Bakong can be polled: give a just-in-time payment a final chance to land
    // before we expire the row, so a payment made right at the deadline still
    // activates instead of being lost. (ABA has no poll API — the Telegram
    // credit-alert listener flips the row; here we just report pending/expired.)
    if (!this.isAba(payment)) {
      const { paid, ref } = await this.bakong.checkPaidByMd5(payment.md5!)
      if (paid) return this.activatePaid(payment, ref ?? null)
    }

    // Past the 30-minute deadline and still unpaid → transition to 'expired' so
    // the client can prompt the user to generate a fresh QR (renew).
    if (this.isExpired(payment)) {
      return this.expirePayment(payment)
    }

    return {
      paymentId: payment.id,
      status: 'pending',
      planCode: payment.plan?.code ?? null,
      activated: false,
      expiresAt: payment.expiresAt,
    }
  }

  /** True once the payment's 30-minute QR deadline has passed. */
  private isExpired(payment: Payment): boolean {
    return payment.expiresAt != null && payment.expiresAt.getTime() <= Date.now()
  }

  /**
   * Transition a stale pending payment (and any linked pending top-up) to
   * 'expired'. Shares the checkStatus response shape.
   */
  private async expirePayment(payment: Payment & { plan: Plan | null }) {
    await this.prisma.$transaction([
      this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'expired' },
      }),
      this.prisma.creditTopup.updateMany({
        where: { paymentId: payment.id, status: 'pending' },
        data: { status: 'expired' },
      }),
    ])
    return {
      paymentId: payment.id,
      status: 'expired' as const,
      planCode: payment.plan?.code ?? null,
      activated: false,
      expiresAt: payment.expiresAt,
    }
  }

  /**
   * Confirm an ABA payment from a Telegram credit alert. ABA's alert carries the
   * amount + trx id but not our payment id, so we match the most recent pending
   * ABA payment with the exact amount that has not expired beyond the grace
   * window (QR lifetime + a short lag allowance for the alert to post).
   * Returns true if a matching payment was found and activated.
   */
  async confirmAbaPaymentByAmount(
    amountUsd: number,
    ref?: string | null,
  ): Promise<boolean> {
    const amountCents = Math.round(amountUsd * 100)
    const payment = await this.prisma.payment.findFirst({
      where: {
        provider: 'aba',
        status: 'pending',
        amountCents,
        expiresAt: { gte: new Date(Date.now() - ABA_MATCH_GRACE_MS) },
      },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    })
    if (!payment) return false
    await this.activatePaid(payment, ref ?? null)
    return true
  }

  private isAba(payment: Payment): boolean {
    return payment.provider === 'aba' || (payment.md5?.startsWith('ABA-') ?? false)
  }

  /**
   * Mark a confirmed payment as paid and apply its effect: either grant the
   * linked credit top-up, or switch the user's subscription (30-day period).
   * Shared by the Bakong poll path and the ABA Telegram listener.
   */
  private async activatePaid(payment: Payment & { plan: Plan | null }, ref: string | null) {
    const topup = await this.prisma.creditTopup.findFirst({
      where: { paymentId: payment.id },
    })
    if (topup) {
      await this.prisma.$transaction([
        this.prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'paid', paidAt: new Date(), externalRef: ref },
        }),
        this.prisma.creditTopup.update({
          where: { id: topup.id },
          data: { status: 'paid' },
        }),
      ])
      return {
        paymentId: payment.id,
        status: 'paid',
        kind: 'topup' as const,
        credits: topup.credits,
        activated: true,
      }
    }

    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    await this.prisma.$transaction([
      this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'paid', paidAt: new Date(), externalRef: ref },
      }),
      this.prisma.subscription.updateMany({
        where: { userId: payment.userId, status: 'active' },
        data: { status: 'canceled' },
      }),
      this.prisma.subscription.create({
        data: {
          userId: payment.userId,
          planId: payment.planId!,
          status: 'active',
          currentPeriodEnd: periodEnd,
        },
      }),
    ])

    return {
      paymentId: payment.id,
      status: 'paid' as const,
      planCode: payment.plan?.code ?? null,
      activated: true,
    }
  }

  /**
   * User-initiated cancel of a pending payment (the "Cancel" button on the
   * checkout screen). Marks it — and any linked pending top-up — 'canceled' so
   * it is no longer reused on refresh, polled, or ABA-alert matched, freeing the
   * user to start a fresh purchase. Rejects canceling an already-paid payment.
   */
  async cancelPayment(paymentId: number, userId: number) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { plan: true },
    })
    if (!payment) throw new NotFoundException('Payment not found')
    if (payment.userId !== userId) throw new ForbiddenException()
    if (payment.status === 'paid') {
      throw new BadRequestException('Payment already completed')
    }
    if (payment.status === 'pending') {
      await this.prisma.$transaction([
        this.prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'canceled' },
        }),
        this.prisma.creditTopup.updateMany({
          where: { paymentId: payment.id, status: 'pending' },
          data: { status: 'canceled' },
        }),
      ])
    }
    return {
      paymentId: payment.id,
      status:
        payment.status === 'pending' ? ('canceled' as const) : payment.status,
      planCode: payment.plan?.code ?? null,
      activated: false,
      expiresAt: payment.expiresAt,
    }
  }

  /**
   * Regenerate a fresh KHQR for an unpaid payment whose QR has expired (or is
   * still pending). The old row (and any linked pending top-up) is marked
   * 'expired', and a brand-new payment for the SAME intent — same plan or same
   * top-up credit amount, same provider — is created with a new QR and a fresh
   * 30-minute deadline. Rejects a payment that is already paid.
   */
  async renewPayment(paymentId: number, userId: number) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { plan: true },
    })
    if (!payment) throw new NotFoundException('Payment not found')
    if (payment.userId !== userId) throw new ForbiddenException()
    if (payment.status === 'paid') {
      throw new BadRequestException('Payment already completed')
    }

    const topup = await this.prisma.creditTopup.findFirst({
      where: { paymentId: payment.id },
    })

    // Expire the old row (+ its pending top-up) so it can no longer be polled
    // or alert-matched to 'paid'. Idempotent when it is already 'expired'.
    if (payment.status === 'pending') {
      await this.prisma.$transaction([
        this.prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'expired' },
        }),
        this.prisma.creditTopup.updateMany({
          where: { paymentId: payment.id, status: 'pending' },
          data: { status: 'expired' },
        }),
      ])
    }

    const method: PaymentMethod =
      payment.provider === 'bakong' ? 'bakong' : 'aba'

    if (topup) {
      return this.createTopupKhqr(userId, topup.credits, method)
    }
    if (payment.plan) {
      return this.createKhqr(userId, payment.plan.code as PlanCode, method)
    }
    throw new BadRequestException('Cannot renew this payment')
  }

  async getUserPayments(userId: number, page: number, pageSize: number) {
    const skip = (page - 1) * pageSize
    const [items, total] = await Promise.all([
      this.prisma.payment.findMany({
        where: { userId },
        include: { plan: { select: { code: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.payment.count({ where: { userId } }),
    ])
    return {
      items: items.map((p) => ({
        id: p.id,
        planCode: p.plan?.code ?? null,
        provider: p.provider,
        amountCents: p.amountCents,
        currency: p.currency,
        status: p.status,
        externalRef: p.externalRef,
        createdAt: p.createdAt,
        paidAt: p.paidAt,
      })),
      total,
      page,
      pageSize,
    }
  }
}
