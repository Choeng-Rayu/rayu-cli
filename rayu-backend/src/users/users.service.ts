import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { Plan, User } from '@prisma/client'
import type { UserStatus } from '../common/enums'
import { PrismaService } from '../prisma/prisma.service'
import { PlansService } from '../plans/plans.service'

export interface ClerkProfile {
  clerkUserId: string
  email?: string | null
  displayName?: string | null
  avatarUrl?: string | null
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plansService: PlansService,
  ) {}

  findById(id: number): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } })
  }

  findByClerkId(clerkUserId: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { clerkUserId } })
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { email } })
  }

  /**
   * Upsert a user from a verified Clerk profile. New users are auto-assigned
   * the Free plan. Returns the persisted user.
   */
  async upsertFromClerk(profile: ClerkProfile): Promise<User> {
    const existing = await this.findByClerkId(profile.clerkUserId)
    if (!existing) {
      const user = await this.prisma.user.create({
        data: {
          clerkUserId: profile.clerkUserId,
          email: profile.email ?? null,
          displayName: profile.displayName ?? null,
          avatarUrl: profile.avatarUrl ?? null,
          role: 'user',
          status: 'active',
          lastActiveAt: new Date(),
        },
      })
      await this.assignFreePlan(user.id)
      return user
    }
    return this.prisma.user.update({
      where: { id: existing.id },
      data: {
        email: profile.email ?? existing.email,
        displayName: profile.displayName ?? existing.displayName,
        avatarUrl: profile.avatarUrl ?? existing.avatarUrl,
        lastActiveAt: new Date(),
      },
    })
  }

  private async assignFreePlan(userId: number): Promise<void> {
    const free = await this.plansService.findByCode('free')
    if (!free) return
    const existing = await this.prisma.subscription.findFirst({
      where: { userId, status: 'active' },
    })
    if (existing) return
    await this.prisma.subscription.create({
      data: { userId, planId: free.id, status: 'active' },
    })
  }

  /**
   * Resolve the user's active subscription (most recent active), honoring the
   * 30-day period: an active subscription whose currentPeriodEnd has passed is
   * treated as expired and falls back to the Free plan. Returns the resolved
   * plan and the period end (null for free/no-expiry).
   */
  async getActiveSubscription(
    userId: number,
  ): Promise<{ plan: Plan; currentPeriodEnd: Date | null }> {
    const sub = await this.prisma.subscription.findFirst({
      where: { userId, status: 'active' },
      include: { plan: true },
      orderBy: { startedAt: 'desc' },
    })
    const now = new Date()
    if (sub?.plan && (!sub.currentPeriodEnd || sub.currentPeriodEnd >= now)) {
      return { plan: sub.plan, currentPeriodEnd: sub.currentPeriodEnd ?? null }
    }
    const free = await this.plansService.findByCode('free')
    if (free) return { plan: free, currentPeriodEnd: null }
    throw new Error('No active plan and no free plan configured')
  }

  /**
   * Resolve the user's active plan (most recent active subscription), falling
   * back to the Free plan when the user has no active (non-expired) subscription.
   */
  async getActivePlanForUser(userId: number): Promise<Plan> {
    return (await this.getActiveSubscription(userId)).plan
  }

  /**
   * Remaining pay-as-you-go top-up credits: granted (paid top-ups) minus
   * consumed (credit_ledger rows with source 'topup'). Never negative.
   */
  async getTopupBalance(userId: number): Promise<number> {
    const [granted, consumed] = await Promise.all([
      this.prisma.creditTopup.aggregate({
        _sum: { credits: true },
        where: { userId, status: 'paid' },
      }),
      this.prisma.creditLedger.aggregate({
        _sum: { credits: true },
        where: { userId, source: 'topup' },
      }),
    ])
    const bal = (granted._sum.credits ?? 0) - (consumed._sum.credits ?? 0)
    return Math.max(0, bal)
  }

  /** Recent credit consumption rows for the user (newest first). */
  async getCreditHistory(userId: number, limit = 50) {
    const take = Math.min(Math.max(limit, 1), 200)
    const rows = await this.prisma.creditLedger.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take,
    })
    return rows.map((r) => ({
      id: r.id,
      modelCode: r.modelCode,
      inTokens: r.inTokens,
      outTokens: r.outTokens,
      credits: r.credits,
      realCostCents: r.realCostCents,
      source: r.source,
      createdAt: r.createdAt,
    }))
  }

  async touchLastActive(id: number): Promise<void> {
    await this.prisma.user.update({
      where: { id },
      data: { lastActiveAt: new Date() },
    })
  }

  async setStatus(id: number, status: UserStatus): Promise<User | null> {
    const existing = await this.findById(id)
    if (!existing) return null
    return this.prisma.user.update({ where: { id }, data: { status } })
  }

  async listUsers(opts: {
    page: number
    pageSize: number
    search?: string
    /** Filter by recent activity (derived from lastActiveAt). */
    activity?: 'active' | 'inactive'
    /** Window that defines "active"; defaults to 30 days. */
    activeWindowDays?: number
  }): Promise<{ items: User[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, opts.page)
    const pageSize = Math.min(100, Math.max(1, opts.pageSize))
    const and: Prisma.UserWhereInput[] = []
    if (opts.search) {
      and.push({
        OR: [
          { email: { contains: opts.search } },
          { displayName: { contains: opts.search } },
          { clerkUserId: { contains: opts.search } },
        ],
      })
    }
    if (opts.activity) {
      const windowDays =
        opts.activeWindowDays && opts.activeWindowDays > 0
          ? opts.activeWindowDays
          : 30
      const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
      if (opts.activity === 'active') {
        // Active: seen within the window.
        and.push({ lastActiveAt: { gte: since } })
      } else {
        // Non-active: stale OR never active (lastActiveAt null).
        and.push({ OR: [{ lastActiveAt: { lt: since } }, { lastActiveAt: null }] })
      }
    }
    const where: Prisma.UserWhereInput = and.length ? { AND: and } : {}
    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.user.count({ where }),
    ])
    return { items, total, page, pageSize }
  }

  countActiveSince(since: Date): Promise<number> {
    return this.prisma.user.count({ where: { lastActiveAt: { gte: since } } })
  }

  countAll(): Promise<number> {
    return this.prisma.user.count()
  }
}
