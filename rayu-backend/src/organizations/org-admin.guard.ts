import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import type { Organization } from '@prisma/client'
import type { AuthedRequest } from '../auth/rayu-auth.guard'
import { OrganizationsService } from './organizations.service'

export interface OrgRequest extends AuthedRequest {
  organization?: Organization
}

/**
 * Must run AFTER RayuAuthGuard (which attaches req.user). Resolves the team from
 * the `:slug` route param and asserts the caller administers it, attaching the
 * org to the request so the handler doesn't re-query it.
 *
 * The membership is read from the DATABASE, not from the JWT's `orgRole` claim:
 * an access token lives for an hour, so a demoted or removed admin would keep
 * their powers until it expired if the claim were trusted here. The claim exists
 * for the gateway's billing decision (where a short window is acceptable and a
 * DB round trip per request is not), never for authorization in this backend.
 */
@Injectable()
export class OrgAdminGuard implements CanActivate {
  constructor(private readonly orgs: OrganizationsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<OrgRequest>()
    if (!req.user) throw new UnauthorizedException('Missing authenticated user')
    const slug = (req.params as Record<string, string> | undefined)?.slug
    if (!slug) throw new BadRequestException('Missing team slug')
    req.organization = await this.orgs.requireAdmin(slug, req.user.id)
    return true
  }
}
