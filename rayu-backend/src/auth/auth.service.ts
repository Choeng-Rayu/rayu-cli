import {
  forwardRef,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtService } from '@nestjs/jwt'
import type { User } from '@prisma/client'
import * as crypto from 'crypto'
import { promisify } from 'util'
import type { OrgRole, UserRole } from '../common/enums'
import {
  OrganizationsService,
  type OrgContext,
} from '../organizations/organizations.service'
import { UsersService } from '../users/users.service'
import { OAuthService } from './oauth.service'
import { CodeStoreService } from './code-store.service'

const scrypt = promisify(crypto.scrypt)

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
  /**
   * TEAM claims — present only when the user holds an active seat in an active
   * organization. Their ABSENCE is the individual-user contract that shipped
   * before teams existed, which is what keeps every already-installed CLI and
   * the gateway's JWT validator working unchanged: no `orgId` ⇒ bill the user's
   * own subscription, exactly as before.
   */
  orgId?: number
  orgRole?: OrgRole
}
interface RefreshClaims {
  sub: number
  type: 'refresh'
}

@Injectable()
export class AuthService {
  constructor(
    private readonly oauth: OAuthService,
    private readonly users: UsersService,
    private readonly codes: CodeStoreService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    // forwardRef: OrganizationsModule needs this module's RayuAuthGuard, and this
    // service needs the org lookup that puts team claims on a token.
    @Inject(forwardRef(() => OrganizationsService))
    private readonly orgs: OrganizationsService,
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
   * Google ID token. We verify it, upsert the Rayu user (Free plan), and
   * return a one-time code bound to the CLI's CSRF state.
   */
  async exchangeOAuthToken(
    idToken: string,
    state: string,
  ): Promise<{ code: string }> {
    const profile = await this.oauth.verifyGoogleIdToken(idToken)
    const user = await this.users.upsertFromOAuth(profile)
    if (user.status !== 'active') {
      throw new UnauthorizedException(`Account is ${user.status}`)
    }
    // Auto-join here too, not just on the web session: a CLI-first user who has
    // never opened the dashboard still lands on their company's team, and the
    // token minted when they redeem this code (redeemCode → mintForUser) then
    // carries the org claims.
    await this.orgs.autoJoinFromHostedDomain(user.id, profile.hostedDomain)
    const code = this.codes.issue(user.id, state)
    return { code }
  }

  /**
   * Browser login: the website exchanges a verified Google ID token for
   * Rayu tokens directly (no one-time code). Used by the web dashboard to call
   * authenticated/admin API endpoints.
   */
  async webSession(
    idToken: string,
  ): Promise<RayuTokens & { user: PublicUser; organization: OrgContext | null }> {
    const profile = await this.oauth.verifyGoogleIdToken(idToken)
    const user = await this.users.upsertFromOAuth(profile)
    if (user.status !== 'active') {
      throw new UnauthorizedException(`Account is ${user.status}`)
    }
    // The hd claim is the auto-join trigger. It returns the user's existing seat
    // when they already have one, so this doubles as the membership lookup.
    const org =
      (await this.orgs.autoJoinFromHostedDomain(user.id, profile.hostedDomain)) ??
      (await this.orgs.findActiveMembership(user.id))
    const tokens = this.mintTokens(user, org)
    return { ...tokens, user: this.toPublicUser(user), organization: org }
  }

  /**
   * Local email/password registration. New users get the Free plan.
   */
  async registerLocal(
    email: string,
    password: string,
    displayName?: string | null,
  ): Promise<RayuTokens & { user: PublicUser }> {
    const hash = await this.hashPassword(password)
    const user = await this.users.createLocalUser(email, hash, displayName)
    if (user.status !== 'active') {
      throw new UnauthorizedException(`Account is ${user.status}`)
    }
    // A brand-new local account cannot be on a team yet (no hd claim exists for
    // email/password sign-up, and an invite has to be accepted explicitly), so
    // this mints the plain individual token without a membership lookup.
    const tokens = this.mintTokens(user)
    return { ...tokens, user: this.toPublicUser(user) }
  }

  /**
   * Local email/password login.
   */
  async loginLocal(
    email: string,
    password: string,
  ): Promise<RayuTokens & { user: PublicUser }> {
    const user = await this.users.findByEmail(email)
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid credentials')
    }
    const valid = await this.verifyPassword(password, user.passwordHash)
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials')
    }
    if (user.status !== 'active') {
      throw new UnauthorizedException(`Account is ${user.status}`)
    }
    const tokens = await this.mintForUser(user)
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
    const tokens = await this.mintForUser(user)
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
    // Team claims are re-resolved on every refresh, so joining or leaving a team
    // (or having a seat removed) reaches the CLI within one token lifetime
    // without the user signing in again.
    return this.mintForUser(user)
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

  /** Hash a plaintext password. Returns `salt:hash` hex string. */
  async hashPassword(password: string): Promise<string> {
    const salt = crypto.randomBytes(16).toString('hex')
    const hash = (await scrypt(password, salt, 64)) as Buffer
    return `${salt}:${hash.toString('hex')}`
  }

  /** Verify a plaintext password against a stored `salt:hash` string. */
  async verifyPassword(password: string, stored: string): Promise<boolean> {
    const [salt, expected] = stored.split(':')
    if (!salt || !expected) return false
    const hash = (await scrypt(password, salt, 64)) as Buffer
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), hash)
  }

  /**
   * Local admin login: email + password (no OAuth provider needed).
   * Only works for users that have a passwordHash set (local accounts).
   */
  async localAdminLogin(
    email: string,
    password: string,
  ): Promise<RayuTokens & { user: PublicUser }> {
    const user = await this.users.findByEmail(email)
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid credentials')
    }
    const valid = await this.verifyPassword(password, user.passwordHash)
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials')
    }
    if (user.status !== 'active') {
      throw new UnauthorizedException(`Account is ${user.status}`)
    }
    if (user.role !== 'admin' && user.role !== 'superadmin') {
      throw new UnauthorizedException('Not an admin account')
    }
    const tokens = await this.mintForUser(user)
    return { ...tokens, user: this.toPublicUser(user) }
  }

  /**
   * Mint tokens for a user, looking up their team seat first. Every sign-in path
   * that can belong to an existing account goes through here so the JWT's team
   * claims are never stale by more than one token lifetime.
   */
  async mintForUser(user: User): Promise<RayuTokens> {
    const org = await this.orgs.findActiveMembership(user.id)
    return this.mintTokens(user, org)
  }

  /**
   * Sign an access + refresh token pair. `org` is optional and additive: passing
   * nothing produces byte-for-byte the same claim set as before teams existed,
   * which is what makes this change safe for already-installed CLIs.
   */
  mintTokens(user: User, org?: OrgContext | null): RayuTokens {
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
        ...(org ? { orgId: org.orgId, orgRole: org.orgRole } : {}),
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
