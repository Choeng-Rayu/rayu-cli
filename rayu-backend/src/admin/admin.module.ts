import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Module,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common'
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
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
import { PlansModule } from '../plans/plans.module'
import { PrismaModule } from '../prisma/prisma.module'
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
  features?: Record<string, unknown>
}

// All admin routes require an active admin/superadmin session.
@Controller('admin')
@UseGuards(RayuAuthGuard, RolesGuard)
@Roles('admin', 'superadmin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('users')
  listUsers(
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
    @Query('search') search?: string,
  ) {
    return this.admin.listUsers(
      parseInt(page, 10) || 1,
      parseInt(pageSize, 10) || 20,
      search,
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
  analytics() {
    return this.admin.analytics()
  }

  // --- Plan / feature entitlement management ---

  @Get('plans')
  listPlans() {
    return this.admin.listPlans()
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
      features,
    })
  }
}

@Module({
  imports: [UsersModule, UsageModule, AuthModule, PrismaModule, PlansModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
