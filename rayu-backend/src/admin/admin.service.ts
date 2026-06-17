import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type { User, Plan } from '@prisma/client'
import type { PlanCode, UserStatus } from '../common/enums'
import { PLAN_CODES } from '../common/enums'
import { FEATURE_CATALOG } from '../common/features'
import { PrismaService } from '../prisma/prisma.service'
import { PlansService, type PlanPatch } from '../plans/plans.service'
import { UsageService } from '../usage/usage.service'
import { UsersService } from '../users/users.service'

export interface AdminStats {
  totalUsers: number
  activeUsers24h: number
  activeUsers7d: number
  usageByProvider: Array<{ provider: string; count: number }>
}

export interface AdminAnalytics {
  totals: {
    totalUsers: number
    activeUsers24h: number
    activeUsers7d: number
    activeUsers30d: number
  }
  statusBreakdown: { active: number; suspended: number; banned: number }
  planDistribution: Array<{
    code: string
    name: string
    priceCents: number
    users: number
  }>
  paidVsFree: { free: number; paid: number }
  revenue: {
    totalCents: number
    paidCount: number
    byMonth: Array<{ month: string; cents: number; count: number }>
  }
  signupsByDay: Array<{ date: string; count: number }>
  activeByDay: Array<{ date: string; count: number }>
  usageByProvider: Array<{ provider: string; count: number }>
  topUsers: Array<{
    id: number
    email: string | null
    displayName: string | null
    count: number
  }>
  canceledSubscriptions: number
}

@Injectable()
export class AdminService {
  constructor(
    private readonly users: UsersService,
    private readonly usage: UsageService,
    private readonly prisma: PrismaService,
    private readonly plans: PlansService,
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

  // --- Plan / feature entitlement management (admin-editable business logic) ---

  private toPlanAdminView(plan: Plan) {
    const limits = this.plans.getLimits(plan)
    return {
      id: plan.id,
      code: plan.code,
      name: plan.name,
      priceCents: plan.priceCents,
      availability: plan.availability,
      maxDailyTurns: limits.maxDailyTurns ?? null,
      features: this.plans.getResolvedFeatures(plan),
    }
  }

  async listPlans() {
    const plans = await this.plans.findAll()
    return {
      catalog: FEATURE_CATALOG,
      plans: plans.map((p) => this.toPlanAdminView(p)),
    }
  }

  async updatePlan(code: string, patch: PlanPatch) {
    const updated = await this.plans.updatePlan(code, patch)
    return this.toPlanAdminView(updated)
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

  // --- Feedback inbox ---

  async listFeedback(page: number, pageSize: number, type?: string) {
    const take = Math.min(Math.max(1, pageSize), 100)
    const skip = (Math.max(1, page) - 1) * take
    const where = type ? { type } : {}
    const [items, total] = await Promise.all([
      this.prisma.feedback.findMany({
        where,
        include: { user: { select: { id: true, email: true, displayName: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.feedback.count({ where }),
    ])
    return {
      items: items.map((f) => ({
        id: f.id,
        type: f.type,
        message: f.message,
        rating: f.rating,
        createdAt: f.createdAt,
        userId: f.userId,
        userEmail: f.user?.email ?? null,
        userName: f.user?.displayName ?? null,
      })),
      total,
      page: Math.max(1, page),
      pageSize: take,
    }
  }

  // --- Bulk user status (multi-select moderation) ---

  async bulkSetStatus(ids: number[], status: UserStatus): Promise<{ updated: number }> {
    if (!ids.length) return { updated: 0 }
    const res = await this.prisma.user.updateMany({
      where: { id: { in: ids } },
      data: { status },
    })
    return { updated: res.count }
  }

  /**
   * Consolidated analytics for the admin dashboard: users, activity, revenue,
   * plan/paid-vs-free distribution, signups & active over time, usage by
   * provider, churn (canceled subs / status), and top users.
   */
  async analytics(days = 30): Promise<AdminAnalytics> {
    const now = new Date()
    const day = 24 * 60 * 60 * 1000
    // Clamp the requested window for the time-series (7/30/90-day toggle).
    const win = Math.min(90, Math.max(7, Math.floor(days) || 30))

    const [
      totalUsers,
      activeUsers24h,
      activeUsers7d,
      activeUsers30d,
      statusRows,
      planRows,
      plans,
      paidAgg,
      canceledSubscriptions,
      usageByProvider,
    ] = await Promise.all([
      this.users.countAll(),
      this.users.countActiveSince(new Date(now.getTime() - day)),
      this.users.countActiveSince(new Date(now.getTime() - 7 * day)),
      this.users.countActiveSince(new Date(now.getTime() - 30 * day)),
      this.prisma.user.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.subscription.groupBy({
        by: ['planId'],
        where: { status: 'active' },
        _count: { _all: true },
      }),
      this.prisma.plan.findMany({ orderBy: { id: 'asc' } }),
      this.prisma.payment.aggregate({
        _sum: { amountCents: true },
        _count: { _all: true },
        where: { status: 'paid' },
      }),
      this.prisma.subscription.count({ where: { status: 'canceled' } }),
      this.usage.usageByProviderGlobal(),
    ])

    const statusBreakdown = { active: 0, suspended: 0, banned: 0 }
    for (const r of statusRows) {
      const s = r.status as keyof typeof statusBreakdown
      if (s in statusBreakdown) statusBreakdown[s] = r._count._all
    }

    const planCount = new Map<number, number>()
    for (const r of planRows) planCount.set(r.planId, r._count._all)
    const planDistribution = plans.map((p) => ({
      code: p.code,
      name: p.name,
      priceCents: p.priceCents,
      users: planCount.get(p.id) ?? 0,
    }))
    const paidVsFree = {
      free: planDistribution
        .filter((p) => p.code === 'free')
        .reduce((s, p) => s + p.users, 0),
      paid: planDistribution
        .filter((p) => p.priceCents > 0)
        .reduce((s, p) => s + p.users, 0),
    }

    // Revenue by month (last 12 months) from paid payments.
    const monthRows = await this.prisma.$queryRaw<
      Array<{ month: string; cents: bigint | number; count: bigint | number }>
    >`
      SELECT DATE_FORMAT(paidAt, '%Y-%m') AS month,
             SUM(amountCents) AS cents,
             COUNT(*) AS count
      FROM payments
      WHERE status = 'paid' AND paidAt IS NOT NULL
        AND paidAt >= (NOW() - INTERVAL 12 MONTH)
      GROUP BY month ORDER BY month ASC`
    const revenueByMonth = monthRows.map((r) => ({
      month: r.month,
      cents: Number(r.cents),
      count: Number(r.count),
    }))

    // New signups per day (windowed).
    const signupRows = await this.prisma.$queryRawUnsafe<
      Array<{ d: Date | string; count: bigint | number }>
    >(
      `SELECT DATE(createdAt) AS d, COUNT(*) AS count
       FROM users
       WHERE createdAt >= (NOW() - INTERVAL ${win} DAY)
       GROUP BY d ORDER BY d ASC`,
    )
    const signupsByDay = this.fillDays(
      signupRows.map((r) => ({
        date: this.toDateStr(r.d),
        count: Number(r.count),
      })),
      win,
      now,
    )

    // Distinct active users per day (windowed) from usage events.
    const activeRows = await this.prisma.$queryRawUnsafe<
      Array<{ d: Date | string; count: bigint | number }>
    >(
      `SELECT DATE(createdAt) AS d, COUNT(DISTINCT user_id) AS count
       FROM usage_events
       WHERE createdAt >= (NOW() - INTERVAL ${win} DAY)
       GROUP BY d ORDER BY d ASC`,
    )
    const activeByDay = this.fillDays(
      activeRows.map((r) => ({
        date: this.toDateStr(r.d),
        count: Number(r.count),
      })),
      win,
      now,
    )

    // Top users by usage volume.
    const topGrouped = await this.prisma.usageEvent.groupBy({
      by: ['userId'],
      _count: { _all: true },
      orderBy: { _count: { userId: 'desc' } },
      take: 10,
    })
    const topIds = topGrouped.map((g) => g.userId)
    const topRecords = topIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: topIds } },
          select: { id: true, email: true, displayName: true },
        })
      : []
    const topMap = new Map(topRecords.map((u) => [u.id, u]))
    const topUsers = topGrouped.map((g) => ({
      id: g.userId,
      email: topMap.get(g.userId)?.email ?? null,
      displayName: topMap.get(g.userId)?.displayName ?? null,
      count: g._count._all,
    }))

    return {
      totals: { totalUsers, activeUsers24h, activeUsers7d, activeUsers30d },
      statusBreakdown,
      planDistribution,
      paidVsFree,
      revenue: {
        totalCents: paidAgg._sum.amountCents ?? 0,
        paidCount: paidAgg._count._all,
        byMonth: revenueByMonth,
      },
      signupsByDay,
      activeByDay,
      usageByProvider,
      topUsers,
      canceledSubscriptions,
    }
  }

  /** Normalize a MySQL DATE value (Date or 'YYYY-MM-DD' string) to YYYY-MM-DD. */
  private toDateStr(d: Date | string): string {
    if (d instanceof Date) return d.toISOString().slice(0, 10)
    return String(d).slice(0, 10)
  }

  /**
   * Produce a continuous series of the last `n` days ending today, filling
   * missing days with 0 so charts render without gaps.
   */
  private fillDays(
    sparse: Array<{ date: string; count: number }>,
    n: number,
    now: Date,
  ): Array<{ date: string; count: number }> {
    const map = new Map(sparse.map((r) => [r.date, r.count]))
    const out: Array<{ date: string; count: number }> = []
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000)
      const key = d.toISOString().slice(0, 10)
      out.push({ date: key, count: map.get(key) ?? 0 })
    }
    return out
  }
}
