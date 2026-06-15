import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import type { Request } from 'express'
import type { User } from '@prisma/client'
import { AuthService } from './auth.service'

export interface AuthedRequest extends Request {
  user?: User
}

/**
 * Verifies the `Authorization: Bearer <rayu access token>` header, loads the
 * live user, rejects suspended/banned accounts, and attaches the user to the
 * request.
 */
@Injectable()
export class RayuAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>()
    const token = this.extractBearer(req)
    if (!token) {
      throw new UnauthorizedException('Missing bearer token')
    }
    req.user = await this.auth.resolveAccessToken(token)
    return true
  }

  private extractBearer(req: Request): string | null {
    const header = req.headers.authorization
    if (!header) return null
    const [scheme, value] = header.split(' ')
    if (scheme?.toLowerCase() !== 'bearer' || !value) return null
    return value.trim()
  }
}
