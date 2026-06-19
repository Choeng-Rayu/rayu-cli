import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Module,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator'
import {
  PLAN_AVAILABILITY,
  PLAN_CODES,
  USER_STATUSES,
  type PlanAvailability,
  type PlanCode,
  type UserStatus,
} from '../common/enums'
import { sanitizeEntitlementsPatch } from '../common/features'
import { AuthModule } from '../auth/auth.module'
import { RayuAuthGuard } from '../auth/rayu-auth.guard'
import { Roles } from '../auth/roles.decorator'
import { RolesGuard } from '../auth/roles.guard'
import { ModelsModule } from '../models/models.module'
import { ModelsService } from '../models/models.service'
import { PlansModule } from '../plans/plans.module'
import { PrismaModule } from '../prisma/prisma.module'
import { AppSettingsModule } from '../settings/app-settings.module'
import { AppSettingsService } from '../settings/app-settings.service'
import { UsageModule } from '../usage/usage.module'
import { UsersModule } from '../users/users.module'
import { AdminService, AdminStats } from './admin.service'

export class UpdateUserStatusDto {
  @IsIn(USER_STATUSES as unknown as string[])
  status!: UserStatus
}

export class UpdateUserPlanDto {
  @IsIn(PLAN_CODES as unknown as string[])
  planCode!: PlanCode
}

export class BulkStatusDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  ids!: number[]

  @IsIn(USER_STATUSES as unknown as string[])
  status!: UserStatus
}

// All fields optional — admin patches only what changes. `features` is a free
// object validated/sanitized in the controller against the feature catalog.
export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  @MaxLength(191)
  name?: string

  @IsOptional()
  @IsInt()
  @Min(0)
  priceCents?: number

  @IsOptional()
  @IsIn(PLAN_AVAILABILITY as unknown as string[])
  availability?: PlanAvailability

  // Allow null (= unlimited); when not null must be a non-negative int.
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  maxDailyTurns?: number | null

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  creditsPerPeriod?: number | null

  @IsOptional()
  @IsBoolean()
  topUpEnabled?: boolean

  @IsOptional()
  features?: Record<string, unknown>
}

class ModelFieldsDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  label?: string

  @IsOptional()
  @IsString()
  @MaxLength(32)
  provider?: string

  @IsOptional()
  @IsString()
  @MaxLength(255)
  upstreamBaseUrl?: string

  @IsOptional()
  @IsString()
  @MaxLength(128)
  upstreamModelId?: string

  @IsOptional()
  @IsInt()
  @Min(0)
  inputPricePer1MCents?: number

  @IsOptional()
  @IsInt()
  @Min(0)
  outputPricePer1MCents?: number

  @IsOptional()
  @IsNumber()
  @Min(0)
  creditMultiplier?: number

  @IsOptional()
  @IsArray()
  @IsIn(PLAN_CODES as unknown as string[], { each: true })
  allowedPlanCodes?: string[]

  @IsOptional()
  @IsBoolean()
  enabled?: boolean
}

export class CreateModelDto extends ModelFieldsDto {
  @IsString()
  @MaxLength(64)
  code!: string
}

export class UpdateModelDto extends ModelFieldsDto {}

export class UpdateSettingsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  baselineCreditsPer1M?: number

  @IsOptional()
  @IsInt()
  @Min(0)
  topupCentsPer1kCredits?: number

  @IsOptional()
  @IsInt()
  @Min(0)
  maxConcurrentStreams?: number

  @IsOptional()
  @IsInt()
  @Min(0)
  maxTokensPerRequest?: number

  @IsOptional()
  @IsInt()
  @Min(0)
  maxRequestsPer5h?: number

  @IsOptional()
  @IsString()
  @MaxLength(64)
  baselineModelCode?: string

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  assumedInputRatio?: number

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  assumedUsagePercent?: number

  @IsOptional()
  @IsInt()
  @Min(0)
  infraCostCentsPerUser?: number
}

// All admin routes require an active admin/superadmin session.
@Controller('admin')
@UseGuards(RayuAuthGuard, RolesGuard)
@Roles('admin', 'superadmin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly models: ModelsService,
    private readonly settings: AppSettingsService,
  ) {}

  @Get('users')
  listUsers(
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
    @Query('search') search?: string,
    @Query('activity') activity?: string,
  ) {
    const act =
      activity === 'active' || activity === 'inactive' ? activity : undefined
    return this.admin.listUsers(
      parseInt(page, 10) || 1,
      parseInt(pageSize, 10) || 20,
      search,
      act,
    )
  }

  @Get('users/:id')
  getUserDetail(@Param('id', ParseIntPipe) id: number) {
    return this.admin.getUserDetail(id)
  }

  @Get('users/:id/payments')
  getUserPayments(
    @Param('id', ParseIntPipe) id: number,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
  ) {
    return this.admin.getUserPayments(
      id,
      parseInt(page, 10) || 1,
      parseInt(pageSize, 10) || 20,
    )
  }

  @Patch('users/:id/status')
  setStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateUserStatusDto,
  ) {
    return this.admin.setUserStatus(id, body.status)
  }

  @Patch('users/:id/plan')
  setUserPlan(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateUserPlanDto,
  ) {
    return this.admin.setUserPlan(id, body.planCode)
  }

  @Get('payments')
  listAllPayments(
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
  ) {
    return this.admin.listAllPayments(
      parseInt(page, 10) || 1,
      parseInt(pageSize, 10) || 20,
    )
  }

  @Get('stats')
  stats(): Promise<AdminStats> {
    return this.admin.stats()
  }

  @Get('analytics')
  analytics(@Query('days') days?: string) {
    return this.admin.analytics(days ? parseInt(days, 10) : undefined)
  }

  @Get('feedback')
  listFeedback(
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
    @Query('type') type?: string,
  ) {
    return this.admin.listFeedback(
      parseInt(page, 10) || 1,
      parseInt(pageSize, 10) || 20,
      type,
    )
  }

  @Patch('users/bulk-status')
  bulkStatus(@Body() body: BulkStatusDto) {
    return this.admin.bulkSetStatus(body.ids, body.status)
  }

  // --- Plan / feature entitlement management ---

  @Get('plans')
  listPlans() {
    return this.admin.listPlans()
  }

  @Get('credit-projection')
  creditProjection() {
    return this.admin.creditProjection()
  }

  @Patch('plans/:code')
  async updatePlan(
    @Param('code') code: string,
    @Body() body: UpdatePlanDto,
  ) {
    // Sanitize the feature entitlements patch against the catalog (400 on bad
    // keys/limits) before handing to the service.
    let features
    if (body.features !== undefined) {
      try {
        features = sanitizeEntitlementsPatch(body.features)
      } catch (err) {
        throw new BadRequestException(
          err instanceof Error ? err.message : 'invalid features',
        )
      }
    }
    return this.admin.updatePlan(code, {
      name: body.name,
      priceCents: body.priceCents,
      availability: body.availability,
      maxDailyTurns: body.maxDailyTurns,
      creditsPerPeriod: body.creditsPerPeriod,
      topUpEnabled: body.topUpEnabled,
      features,
    })
  }

  // --- Hosted models (reseller catalog) ---

  @Get('models')
  listModels() {
    return this.models.findAll()
  }

  @Post('models')
  createModel(@Body() body: CreateModelDto) {
    return this.models.create(body)
  }

  @Patch('models/:code')
  updateModel(@Param('code') code: string, @Body() body: UpdateModelDto) {
    return this.models.update(code, body)
  }

  @Delete('models/:code')
  deleteModel(@Param('code') code: string) {
    return this.models.remove(code)
  }

  // --- Global credit settings ---

  @Get('credit-settings')
  getCreditSettings() {
    return this.settings.get()
  }

  @Patch('credit-settings')
  updateCreditSettings(@Body() body: UpdateSettingsDto) {
    return this.settings.update(body)
  }
}

@Module({
  imports: [
    UsersModule,
    UsageModule,
    AuthModule,
    PrismaModule,
    PlansModule,
    ModelsModule,
    AppSettingsModule,
  ],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
