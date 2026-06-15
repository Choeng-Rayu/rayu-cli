import {
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtService } from '@nestjs/jwt'
import type { User } from '@prisma/client'
import type { UserRole } from '../common/enums'
import { UsersService } from '../users/users.service'
import { ClerkService } from './clerk.service'
import { CodeStoreService } from './code-store.service'

export interface RayuTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number // epoch ms for the access token
}

export interface PublicUser {
  id: number
  email: string | null
  displayName: string | null
  avatarUrl: string | null
  role: UserRole
}

interface AccessClaims {
  sub: number
  role: UserRole
  type: 'access'
}
interface RefreshClaims {
  sub: number
  type: 'refresh'
}

@Injectable()
export class AuthService {
  constructor(
    private readonly clerk: ClerkService,
    private readonly users: UsersService,
    private readonly codes: CodeStoreService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  toPublicUser(user: User): PublicUser {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      role: user.role as UserRole,
    }
  }

  /**
   * Step 1 of the CLI bridge: the website calls this with the signed-in user's
   * Clerk session token. We verify it, upsert the Rayu user (Free plan), and
   * return a one-time code bound to the CLI's CSRF state.
   */
  async exchangeClerkToken(
    clerkToken: string,
    state: string,
  ): Promise<{ code: string }> {
    const profile = await this.clerk.verifySessionToken(clerkToken)
    const user = await this.users.upsertFromClerk(profile)
    if (user.status !== 'active') {
      throw new UnauthorizedException(`Account is ${user.status}`)
    }
    const code = this.codes.issue(user.id, state)
    return { code }
  }

  /**
   * Browser login: the website exchanges a signed-in Clerk session token for
   * Rayu tokens directly (no one-time code). Used by the web dashboard to call
   * authenticated/admin API endpoints.
   */
  async webSession(
    clerkToken: string,
  ): Promise<RayuTokens & { user: PublicUser }> {
    const profile = await this.clerk.verifySessionToken(clerkToken)
    const user = await this.users.upsertFromClerk(profile)
    if (user.status !== 'active') {
      throw new UnauthorizedException(`Account is ${user.status}`)
    }
    const tokens = this.mintTokens(user)
    return { ...tokens, user: this.toPublicUser(user) }
  }

  /**
   * Step 2 of the CLI bridge: the CLI redeems the one-time code for Rayu
   * tokens.
   */
  async redeemCode(
    code: string,
  ): Promise<RayuTokens & { user: PublicUser }> {
    const redeemed = this.codes.consume(code)
    if (!redeemed) {
      throw new UnauthorizedException('Invalid or expired code')
    }
    const user = await this.users.findById(redeemed.userId)
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('Account is not active')
    }
    const tokens = this.mintTokens(user)
    return { ...tokens, user: this.toPublicUser(user) }
  }

  async refresh(refreshToken: string): Promise<RayuTokens> {
    let claims: RefreshClaims
    try {
      claims = this.jwt.verify<RefreshClaims>(refreshToken)
    } catch {
      throw new UnauthorizedException('Invalid refresh token')
    }
    if (claims.type !== 'refresh') {
      throw new UnauthorizedException('Not a refresh token')
    }
    const user = await this.users.findById(claims.sub)
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('Account is not active')
    }
    return this.mintTokens(user)
  }

  /** Verify an access token and return the live user (used by the guard). */
  async resolveAccessToken(token: string): Promise<User> {
    let claims: AccessClaims
    try {
      claims = this.jwt.verify<AccessClaims>(token)
    } catch {
      throw new UnauthorizedException('Invalid access token')
    }
    if (claims.type !== 'access') {
      throw new UnauthorizedException('Not an access token')
    }
    const user = await this.users.findById(claims.sub)
    if (!user) throw new UnauthorizedException('Unknown user')
    if (user.status !== 'active') {
      throw new UnauthorizedException(`Account is ${user.status}`)
    }
    return user
  }

  mintTokens(user: User): RayuTokens {
    const accessTtl = this.config.get<number>('app.accessTokenTtlSeconds', 3600)
    const refreshTtl = this.config.get<number>(
      'app.refreshTokenTtlSeconds',
      60 * 60 * 24 * 30,
    )
    const accessToken = this.jwt.sign(
      {
        sub: user.id,
        role: user.role as UserRole,
        type: 'access',
      } satisfies AccessClaims,
      { expiresIn: accessTtl },
    )
    const refreshToken = this.jwt.sign(
      { sub: user.id, type: 'refresh' } satisfies RefreshClaims,
      { expiresIn: refreshTtl },
    )
    return {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + accessTtl * 1000,
    }
  }
}
