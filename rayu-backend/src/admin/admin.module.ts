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
import { USER_STATUSES, type UserStatus } from '../common/enums'
import { AuthModule } from '../auth/auth.module'
import { RayuAuthGuard } from '../auth/rayu-auth.guard'
import { Roles } from '../auth/roles.decorator'
import { RolesGuard } from '../auth/roles.guard'
import { UsageModule } from '../usage/usage.module'
import { UsersModule } from '../users/users.module'
import { AdminService, AdminStats } from './admin.service'

export class UpdateUserStatusDto {
  @IsIn(USER_STATUSES as unknown as string[])
  status!: UserStatus
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

  @Patch('users/:id/status')
  setStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateUserStatusDto,
  ) {
    return this.admin.setUserStatus(id, body.status)
  }

  @Get('stats')
  stats(): Promise<AdminStats> {
    return this.admin.stats()
  }
}

@Module({
  imports: [UsersModule, UsageModule, AuthModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
