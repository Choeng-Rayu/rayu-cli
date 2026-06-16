import {
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
import { IsIn } from 'class-validator'
import { PLAN_CODES, USER_STATUSES, type PlanCode, type UserStatus } from '../common/enums'
import { AuthModule } from '../auth/auth.module'
import { RayuAuthGuard } from '../auth/rayu-auth.guard'
import { Roles } from '../auth/roles.decorator'
import { RolesGuard } from '../auth/roles.guard'
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
}

@Module({
  imports: [UsersModule, UsageModule, AuthModule, PrismaModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
