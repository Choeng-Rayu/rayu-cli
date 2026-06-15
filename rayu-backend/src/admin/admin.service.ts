import { Injectable, NotFoundException } from '@nestjs/common'
import type { User } from '@prisma/client'
import type { UserStatus } from '../common/enums'
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
  ) {}

  listUsers(page: number, pageSize: number, search?: string) {
    return this.users.listUsers({ page, pageSize, search })
  }

  async setUserStatus(id: number, status: UserStatus): Promise<User> {
    const user = await this.users.setStatus(id, status)
    if (!user) throw new NotFoundException('User not found')
    return user
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
