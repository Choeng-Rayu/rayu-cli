import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type { PlanCode } from '../common/enums'
import { PrismaService } from '../prisma/prisma.service'
import { BakongService } from './bakong.service'

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bakong: BakongService,
  ) {}

  async createKhqr(userId: number, planCode: PlanCode) {
    const plan = await this.prisma.plan.findUnique({ where: { code: planCode } })
    if (!plan) throw new NotFoundException('Plan not found')
    if (plan.availability !== 'active' || plan.priceCents <= 0) {
      throw new BadRequestException('Plan is not purchasable')
    }

    const amountUsd = plan.priceCents / 100
    const billNumber = `RAYU-${userId}-${Date.now()}`
    const { qr, md5 } = this.bakong.generateKhqr(amountUsd, billNumber)

    const payment = await this.prisma.payment.create({
      data: {
        userId,
        planId: plan.id,
        amountCents: plan.priceCents,
        currency: 'USD',
        status: 'pending',
        md5,
        khqr: qr,
      },
    })

    return { paymentId: payment.id, planCode, amountCents: plan.priceCents, currency: 'USD', qr, md5 }
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

    const { paid, ref } = await this.bakong.checkPaidByMd5(payment.md5!)
    if (!paid) {
      return { paymentId: payment.id, status: 'pending', planCode: payment.plan?.code ?? null, activated: false }
    }

    // Activate: mark paid + switch subscription
    await this.prisma.$transaction([
      this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'paid', paidAt: new Date(), externalRef: ref ?? null },
      }),
      this.prisma.subscription.updateMany({
        where: { userId, status: 'active' },
        data: { status: 'canceled' },
      }),
      this.prisma.subscription.create({
        data: { userId, planId: payment.planId!, status: 'active' },
      }),
    ])

    return { paymentId: payment.id, status: 'paid', planCode: payment.plan?.code ?? null, activated: true }
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
