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
import { AbaService } from './aba.service'
import { BakongService } from './bakong.service'

export type PaymentMethod = 'aba' | 'bakong'

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bakong: BakongService,
    private readonly aba: AbaService,
    private readonly settings: AppSettingsService,
  ) {}

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
      },
    })
    await this.prisma.creditTopup.create({
      data: { userId, credits, amountCents, status: 'pending', paymentId: payment.id },
    })

    return { paymentId: payment.id, credits, amountCents, currency: 'USD', method, qr, md5 }
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
      const qr = this.aba.generateAbaQR(amountUsd)
      return { qr, md5: `ABA-${randomUUID()}`, provider: 'aba' }
    }
    const { qr, md5 } = this.bakong.generateKhqr(amountUsd, billNumber)
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
      }
    }

    // ABA has no API to poll — the Telegram credit-alert listener flips the row
    // when the alert arrives. The frontend just polls the DB until then.
    if (this.isAba(payment)) {
      return {
        paymentId: payment.id,
        status: 'pending',
        planCode: payment.plan?.code ?? null,
        activated: false,
      }
    }

    const { paid, ref } = await this.bakong.checkPaidByMd5(payment.md5!)
    if (!paid) {
      return { paymentId: payment.id, status: 'pending', planCode: payment.plan?.code ?? null, activated: false }
    }

    return this.activatePaid(payment, ref ?? null)
  }

  /**
   * Confirm an ABA payment from a Telegram credit alert. ABA's alert carries the
   * amount + trx id but not our payment id, so we match the most recent pending
   * ABA payment with the exact amount (created within the QR's lifetime window).
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
        createdAt: { gte: new Date(Date.now() - 15 * 60 * 1000) },
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
