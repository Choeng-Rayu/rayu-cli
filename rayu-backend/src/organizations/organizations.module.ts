import { forwardRef, Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { PlansModule } from '../plans/plans.module'
import { AdminOrganizationsController } from './admin-organizations.controller'
import { OrgAdminGuard } from './org-admin.guard'
import { OrganizationsController } from './organizations.controller'
import { OrganizationsService } from './organizations.service'

/**
 * forwardRef breaks a genuine two-way dependency, not a layering mistake:
 * AuthModule needs OrganizationsService to put `orgId`/`orgRole` on a freshly
 * minted JWT (and to auto-join a Workspace signer), while this module needs
 * AuthModule's RayuAuthGuard to authenticate its own HTTP routes.
 */
@Module({
  imports: [forwardRef(() => AuthModule), PlansModule],
  controllers: [OrganizationsController, AdminOrganizationsController],
  providers: [OrganizationsService, OrgAdminGuard],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
