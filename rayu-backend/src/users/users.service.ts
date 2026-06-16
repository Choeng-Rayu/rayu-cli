import { Injectable } from '@nestjs/common'
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
   * Resolve the user's active plan (most recent active subscription), falling
   * back to the Free plan when the user has no active subscription.
   */
  async getActivePlanForUser(userId: number): Promise<Plan> {
    const sub = await this.prisma.subscription.findFirst({
      where: { userId, status: 'active' },
      include: { plan: true },
      orderBy: { startedAt: 'desc' },
    })
    if (sub?.plan) return sub.plan
    const free = await this.plansService.findByCode('free')
    if (free) return free
    throw new Error('No active plan and no free plan configured')
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
  }): Promise<{ items: User[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, opts.page)
    const pageSize = Math.min(100, Math.max(1, opts.pageSize))
    const where = opts.search
      ? {
          OR: [
            { email: { contains: opts.search } },
            { displayName: { contains: opts.search } },
            { clerkUserId: { contains: opts.search } },
          ],
        }
      : {}
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
