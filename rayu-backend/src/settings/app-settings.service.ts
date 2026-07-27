import { Injectable } from '@nestjs/common'
import type { AppSettings } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'

export interface SettingsPatch {
  baselineCreditsPer1M?: number
  creditsPerDollar?: number
  minTopupCents?: number
  maxConcurrentStreams?: number
  maxTokensPerRequest?: number
  maxRequestsPer5h?: number
  baselineModelCode?: string | null
  assumedInputRatio?: number
  assumedUsagePercent?: number
  infraCostCentsPerUser?: number
}

const SINGLETON_ID = 1

@Injectable()
export class AppSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Return the singleton settings row, creating it with defaults if missing. */
  async get(): Promise<AppSettings> {
    const existing = await this.prisma.appSettings.findUnique({
      where: { id: SINGLETON_ID },
    })
    if (existing) return existing
    // First-time default for the credit model: baselineCreditsPer1M=1 means
    // 1 credit = 1e6/1 = 1,000,000 tokens at the reference model (×1). Cheaper
    // models use a <1 creditMultiplier. All admin-editable afterwards.
    return this.prisma.appSettings.create({
      data: { id: SINGLETON_ID, baselineCreditsPer1M: 1 },
    })
  }

  async update(patch: SettingsPatch): Promise<AppSettings> {
    await this.get() // ensure the row exists
    return this.prisma.appSettings.update({
      where: { id: SINGLETON_ID },
      data: patch,
    })
  }

  /** Non-destructive: just ensures the defaults row exists. */
  async seedDefaults(): Promise<void> {
    await this.get()
  }
}
