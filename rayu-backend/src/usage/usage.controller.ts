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
import { CurrentUser } from '../auth/current-user.decorator'
import { RayuAuthGuard } from '../auth/rayu-auth.guard'
import type { User } from '@prisma/client'
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
  constructor(private readonly usage: UsageService) {}

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
}
