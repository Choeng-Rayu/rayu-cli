import {
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createClerkClient, verifyToken } from '@clerk/backend'

export interface VerifiedClerkUser {
  clerkUserId: string
  email: string | null
  displayName: string | null
  avatarUrl: string | null
}

/**
 * Verifies Clerk session tokens server-side and resolves the user's profile.
 * The CLI never talks to Clerk directly — only this backend does.
 *
 * This service is intentionally small and injectable so it can be mocked in
 * e2e tests (no real Clerk instance required).
 */
@Injectable()
export class ClerkService {
  private readonly logger = new Logger(ClerkService.name)
  private readonly secretKey: string | undefined

  constructor(private readonly config: ConfigService) {
    this.secretKey = this.config.get<string>('app.clerkSecretKey')
  }

  async verifySessionToken(token: string): Promise<VerifiedClerkUser> {
    if (!this.secretKey) {
      throw new UnauthorizedException('Clerk is not configured on the server')
    }
    let sub: string
    try {
      const claims = await verifyToken(token, { secretKey: this.secretKey })
      sub = claims.sub
    } catch (err) {
      this.logger.warn(`Clerk token verification failed: ${String(err)}`)
      throw new UnauthorizedException('Invalid Clerk session token')
    }
    if (!sub) {
      throw new UnauthorizedException('Clerk token missing subject')
    }

    try {
      const client = createClerkClient({ secretKey: this.secretKey })
      const u = await client.users.getUser(sub)
      const primaryEmail =
        u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId)
          ?.emailAddress ??
        u.emailAddresses[0]?.emailAddress ??
        null
      const displayName =
        [u.firstName, u.lastName].filter(Boolean).join(' ').trim() ||
        u.username ||
        null
      return {
        clerkUserId: sub,
        email: primaryEmail,
        displayName,
        avatarUrl: u.imageUrl ?? null,
      }
    } catch (err) {
      // Token verified but profile lookup failed — still allow login with the
      // subject id; profile fields can be backfilled on a later login.
      this.logger.warn(`Clerk profile lookup failed: ${String(err)}`)
      return {
        clerkUserId: sub,
        email: null,
        displayName: null,
        avatarUrl: null,
      }
    }
  }
}
