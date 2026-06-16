import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type { User } from '@prisma/client'
import type { PlanCode, UserStatus } from '../common/enums'
import { PLAN_CODES } from '../common/enums'
import { PrismaService } from '../prisma/prisma.service'
import { UsageService } from '../usage/usage.service'
import { UsersService } from '../users/users.service'

export interface AdminStats {
  totalUsers: number
  activeUsers24h: number
  activeUsers7d: number
  usageByProvider: Array<{ provider: string; count: number }>
}

@Injectable()
export class AdminService {
  constructor(
    private readonly users: UsersService,
    private readonly usage: UsageService,
    private readonly prisma: PrismaService,
  ) {}

  listUsers(page: number, pageSize: number, search?: string) {
    return this.users.listUsers({ page, pageSize, search })
  }

  async setUserStatus(id: number, status: UserStatus): Promise<User> {
    const user = await this.users.setStatus(id, status)
    if (!user) throw new NotFoundException('User not found')
    return user
  }

  async getUserDetail(id: number) {
    const user = await this.prisma.user.findUnique({ where: { id } })
    if (!user) throw new NotFoundException('User not found')
    const subscription = await this.prisma.subscription.findFirst({
      where: { userId: id, status: 'active' },
      include: { plan: { select: { id: true, code: true, name: true, priceCents: true } } },
      orderBy: { startedAt: 'desc' },
    })
    return {
      user,
      plan: subscription?.plan ?? null,
      subscription: subscription
        ? {
            id: subscription.id,
            status: subscription.status,
            startedAt: subscription.startedAt,
            currentPeriodEnd: subscription.currentPeriodEnd,
          }
        : null,
    }
  }

  async getUserPayments(id: number, page: number, pageSize: number) {
    const user = await this.prisma.user.findUnique({ where: { id } })
    if (!user) throw new NotFoundException('User not found')
    const skip = (page - 1) * pageSize
    const [items, total] = await Promise.all([
      this.prisma.payment.findMany({
        where: { userId: id },
        include: { plan: { select: { code: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: Math.min(pageSize, 100),
      }),
      this.prisma.payment.count({ where: { userId: id } }),
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
        md5: p.md5,
        createdAt: p.createdAt,
        paidAt: p.paidAt,
      })),
      total,
      page,
      pageSize,
    }
  }

  async setUserPlan(userId: number, planCode: PlanCode) {
    if (!PLAN_CODES.includes(planCode)) throw new BadRequestException('Invalid plan code')
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user) throw new NotFoundException('User not found')
    const plan = await this.prisma.plan.findUnique({ where: { code: planCode } })
    if (!plan) throw new NotFoundException('Plan not found')

    await this.prisma.$transaction([
      this.prisma.subscription.updateMany({
        where: { userId, status: 'active' },
        data: { status: 'canceled' },
      }),
      this.prisma.subscription.create({
        data: { userId, planId: plan.id, status: 'active' },
      }),
    ])

    return this.getUserDetail(userId)
  }

  async listAllPayments(page: number, pageSize: number) {
    const skip = (page - 1) * pageSize
    const [items, total] = await Promise.all([
      this.prisma.payment.findMany({
        include: {
          user: { select: { email: true } },
          plan: { select: { code: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: Math.min(pageSize, 100),
      }),
      this.prisma.payment.count(),
    ])
    return {
      items: items.map((p) => ({
        id: p.id,
        userEmail: p.user.email,
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

  async stats(): Promise<AdminStats> {
    const now = Date.now()
    const [totalUsers, activeUsers24h, activeUsers7d, usageByProvider] =
      await Promise.all([
        this.users.countAll(),
        this.users.countActiveSince(new Date(now - 24 * 60 * 60 * 1000)),
        this.users.countActiveSince(new Date(now - 7 * 24 * 60 * 60 * 1000)),
        this.usage.usageByProviderGlobal(),
      ])
    return { totalUsers, activeUsers24h, activeUsers7d, usageByProvider }
  }
}
