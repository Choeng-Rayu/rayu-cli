import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { UserRole } from '../common/enums'
import type { AuthedRequest } from './rayu-auth.guard'
import { ROLES_KEY } from './roles.decorator'

/**
 * Must run AFTER RayuAuthGuard (which attaches req.user). Enforces that the
 * authenticated user has one of the required roles.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    )
    if (!required || required.length === 0) return true
    const req = context.switchToHttp().getRequest<AuthedRequest>()
    const role = req.user?.role as UserRole | undefined
    if (!role || !required.includes(role)) {
      throw new ForbiddenException('Insufficient role')
    }
    return true
  }
}
