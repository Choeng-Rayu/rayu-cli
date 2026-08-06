import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import type { Request } from 'express'
import type { User } from '@prisma/client'
import { AuthService } from '../auth/auth.service'
import type { AuthedRequest } from '../auth/rayu-auth.guard'

/**
 * Authenticates the git proxy using the `X-Rayu-Token` header.
 *
 * WHY NOT THE NORMAL BEARER GUARD
 *
 * The git proxy relays git smart-HTTP traffic for isomorphic-git running in the
 * browser. For a private repository, isomorphic-git puts the user's GIT
 * credential in the `Authorization` header (Basic user:PAT) and expects it to
 * reach the git host. If our own session token also used `Authorization`, one
 * would have to overwrite the other: either we cannot authenticate the caller, or
 * we strip the credential the repository requires.
 *
 * So identity moves to a separate header, exactly as rayu-gateway's /v1/proxy
 * does for BYO-key provider calls (there too `Authorization` is occupied by a
 * third-party credential). `Authorization` is then forwarded upstream untouched.
 */
@Injectable()
export class StudioProxyTokenGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>()
    const token = this.extractToken(req)

    if (!token) {
      throw new UnauthorizedException(
        'Missing X-Rayu-Token. The git proxy authenticates with this header because ' +
          'Authorization carries the git credential to forward upstream.',
      )
    }

    req.user = (await this.auth.resolveAccessToken(token)) as User

    return true
  }

  private extractToken(req: Request): string | null {
    const raw = req.headers['x-rayu-token']
    const value = Array.isArray(raw) ? raw[0] : raw

    if (!value) {
      return null
    }

    // Accept a bare token or a "Bearer <token>" form.
    const trimmed = value.trim()

    return trimmed.toLowerCase().startsWith('bearer ') ? trimmed.slice(7).trim() : trimmed
  }
}
