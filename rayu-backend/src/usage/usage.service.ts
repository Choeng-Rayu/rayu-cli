import { Injectable } from '@nestjs/common'
import type { UsageEvent } from '@prisma/client'
import type { UsageSource } from '../common/enums'
import { PrismaService } from '../prisma/prisma.service'
import { UsersService } from '../users/users.service'

export interface UsageSummary {
  total: number
  topProvider: string | null
  byProvider: Array<{ provider: string; count: number }>
}

@Injectable()
export class UsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
  ) {}

  async record(
    userId: number,
    provider: string,
    model: string | null,
    source: UsageSource,
    tool?: string | null,
  ): Promise<UsageEvent> {
    const event = await this.prisma.usageEvent.create({
      data: { userId, provider, model, source, tool: tool ?? null },
    })
    await this.users.touchLastActive(userId)
    return event
  }

  async summaryForUser(userId: number): Promise<UsageSummary> {
    const grouped = await this.prisma.usageEvent.groupBy({
      by: ['provider'],
      where: { userId },
      _count: { _all: true },
    })
    const byProvider = grouped
      .map((g) => ({ provider: g.provider, count: g._count._all }))
      .sort((a, b) => b.count - a.count)
    const total = byProvider.reduce((sum, r) => sum + r.count, 0)
    return { total, topProvider: byProvider[0]?.provider ?? null, byProvider }
  }

  async usageByProviderGlobal(): Promise<
    Array<{ provider: string; count: number }>
  > {
    const grouped = await this.prisma.usageEvent.groupBy({
      by: ['provider'],
      _count: { _all: true },
    })
    return grouped
      .map((g) => ({ provider: g.provider, count: g._count._all }))
      .sort((a, b) => b.count - a.count)
  }

  async usageByToolGlobal(): Promise<Array<{ tool: string; count: number }>> {
    const grouped = await this.prisma.usageEvent.groupBy({
      by: ['tool'],
      where: { tool: { not: null } },
      _count: { _all: true },
    })
    return grouped
      .filter((g) => g.tool != null)
      .map((g) => ({ tool: g.tool as string, count: g._count._all }))
      .sort((a, b) => b.count - a.count)
  }

  /**
   * Count a user's usage_events for the given tool names since the start of the
   * current UTC calendar month (resets on the 1st). Drives per-feature monthly
   * limit enforcement (e.g. image generation = 10/month). Empty toolNames -> 0.
   */
  async featureUsageThisMonth(
    userId: number,
    toolNames: string[],
  ): Promise<number> {
    if (toolNames.length === 0) return 0
    const now = new Date()
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    )
    return this.prisma.usageEvent.count({
      where: {
        userId,
        tool: { in: toolNames },
        createdAt: { gte: monthStart },
      },
    })
  }
}
