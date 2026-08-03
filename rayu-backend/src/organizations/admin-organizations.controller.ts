import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import { RayuAuthGuard } from '../auth/rayu-auth.guard'
import { Roles } from '../auth/roles.decorator'
import { RolesGuard } from '../auth/roles.guard'
import { OrganizationsService } from './organizations.service'

/**
 * Super-admin oversight of teams: list, inspect, suspend/resume, force a period
 * renewal.
 *
 * It lives in the organizations module (rather than inside the big
 * src/admin/admin.module.ts barrel) so all team logic and its authorization sit
 * together, and so adding team oversight does not touch the admin module's
 * unrelated routes. The guards and role decorator are identical to the ones the
 * admin controller applies, so the security posture is unchanged: an active
 * admin/superadmin session is required.
 */
@Controller('admin/organizations')
@UseGuards(RayuAuthGuard, RolesGuard)
@Roles('admin', 'superadmin')
export class AdminOrganizationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  @Get()
  list(
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
    @Query('search') search?: string,
  ) {
    return this.orgs.listOrganizations({
      page: parseInt(page, 10) || 1,
      pageSize: Math.min(parseInt(pageSize, 10) || 20, 100),
      search: search?.trim() || undefined,
    })
  }

  @Get(':id')
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.orgs.getOrganizationDetail(id)
  }

  /**
   * Suspend a team: subscription canceled and every seat deactivated, so each
   * member's next token carries no org claim and they fall back to their own
   * individual plan. Reversible — nothing is deleted.
   */
  @Post(':id/suspend')
  suspend(@Param('id', ParseIntPipe) id: number) {
    return this.orgs.suspendOrganization(id)
  }

  @Post(':id/resume')
  resume(@Param('id', ParseIntPipe) id: number) {
    return this.orgs.resumeOrganization(id)
  }

  /**
   * Force the team into a fresh period: re-seed the pool and reset every
   * member's bucket to their quota. This is the operator's handle on renewal
   * until a scheduler exists.
   */
  @Post(':id/renew')
  renew(@Param('id', ParseIntPipe) id: number) {
    return this.orgs.renewSubscription(id)
  }
}
