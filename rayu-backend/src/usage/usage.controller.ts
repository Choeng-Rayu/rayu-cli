import {
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
} from '@nestjs/common'
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator'
import { USAGE_SOURCES, type UsageSource } from '../common/enums'
import { FEATURE_CATALOG, toolsForFeature } from '../common/features'
import { CurrentUser } from '../auth/current-user.decorator'
import { RayuAuthGuard } from '../auth/rayu-auth.guard'
import type { User } from '@prisma/client'
import { PlansService } from '../plans/plans.service'
import { UsersService } from '../users/users.service'
import { UsageService, UsageSummary } from './usage.service'

export class RecordUsageDto {
  @IsString()
  @MaxLength(64)
  provider!: string

  @IsOptional()
  @IsString()
  @MaxLength(128)
  model?: string

  @IsOptional()
  @IsString()
  @MaxLength(64)
  tool?: string

  @IsOptional()
  @IsIn(USAGE_SOURCES as unknown as string[])
  source?: UsageSource
}

@Controller('usage')
@UseGuards(RayuAuthGuard)
export class UsageController {
  constructor(
    private readonly usage: UsageService,
    private readonly plans: PlansService,
    private readonly users: UsersService,
  ) {}

  @Post()
  async record(
    @CurrentUser() user: User,
    @Body() body: RecordUsageDto,
  ): Promise<{ ok: true }> {
    await this.usage.record(
      user.id,
      body.provider,
      body.model ?? null,
      body.source ?? 'cli',
      body.tool ?? null,
    )
    return { ok: true }
  }

  @Get('summary')
  summary(@CurrentUser() user: User): Promise<UsageSummary> {
    return this.usage.summaryForUser(user.id)
  }

  /**
   * Per-feature usage for the signed-in user this UTC calendar month, paired
   * with the plan's numeric limit. Drives the CLI's soft per-feature cap (e.g.
   * image generation = 10/month). Only enabled, limit-capable features are
   * returned; limit:null means unlimited. All values are admin-managed (DB),
   * never hardcoded.
   */
  @Get('features')
  async featureUsage(
    @CurrentUser() user: User,
  ): Promise<Record<string, { used: number; limit: number | null }>> {
    const { plan } = await this.users.getActiveSubscription(user.id)
    const features = this.plans.getResolvedFeatures(plan)
    const limited = FEATURE_CATALOG.filter(
      (f) => f.supportsLimit && features[f.key]?.enabled,
    )
    const counts = await Promise.all(
      limited.map((f) =>
        this.usage.featureUsageThisMonth(user.id, toolsForFeature(f.key)),
      ),
    )
    const out: Record<string, { used: number; limit: number | null }> = {}
    limited.forEach((f, i) => {
      out[f.key] = { used: counts[i] ?? 0, limit: features[f.key].limit ?? null }
    })
    return out
  }
}
