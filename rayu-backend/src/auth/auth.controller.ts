import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common'
import { CurrentUser } from './current-user.decorator'
import type { User } from '@prisma/client'
import { PlansService } from '../plans/plans.service'
import { ModelsService } from '../models/models.service'
import { AppSettingsService } from '../settings/app-settings.service'
import { UsersService } from '../users/users.service'
import { AuthService, PublicUser, RayuTokens } from './auth.service'
import { ExchangeDto, GoogleOAuthDto, LocalLoginDto, RefreshDto, RegisterDto, TokenDto } from './dto/auth.dto'
import { RayuAuthGuard } from './rayu-auth.guard'

@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly plans: PlansService,
    private readonly users: UsersService,
    private readonly models: ModelsService,
    private readonly settings: AppSettingsService,
  ) {}

  /**
   * Called by the website's /cli-login bridge. The signed-in user's Google ID
   * token is passed in the Authorization header; the CLI's CSRF state is in the
   * body. Returns a one-time code.
   */
  @Post('cli/exchange')
  async exchange(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: ExchangeDto,
  ): Promise<{ code: string }> {
    const idToken = this.extractBearer(authorization)
    if (!idToken) {
      throw new UnauthorizedException('Missing Google ID token')
    }
    return this.auth.exchangeOAuthToken(idToken, body.state)
  }

  /** Called by the CLI to redeem the one-time code for Rayu tokens. */
  @Post('cli/token')
  redeem(@Body() body: TokenDto): Promise<RayuTokens & { user: PublicUser }> {
    return this.auth.redeemCode(body.code)
  }

  /**
   * Browser login for the website/dashboard: exchange a Google ID token
   * (Authorization header) for Rayu tokens directly.
   */
  @Post('web/session')
  async webSession(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<RayuTokens & { user: PublicUser }> {
    const idToken = this.extractBearer(authorization)
    if (!idToken) {
      throw new UnauthorizedException('Missing Google ID token')
    }
    return this.auth.webSession(idToken)
  }

  /**
   * Browser login via verified Google ID token in the request body.
   * Used when the frontend has already performed the Google OAuth handshake.
   */
  @Post('auth/oauth/google')
  googleOAuth(
    @Body() body: GoogleOAuthDto,
  ): Promise<RayuTokens & { user: PublicUser }> {
    return this.auth.webSession(body.idToken)
  }

  /** Local email/password registration. */
  @Post('auth/register')
  register(
    @Body() body: RegisterDto,
  ): Promise<RayuTokens & { user: PublicUser }> {
    return this.auth.registerLocal(body.email, body.password, body.displayName)
  }

  /** Local email/password login. */
  @Post('auth/login')
  login(
    @Body() body: LocalLoginDto,
  ): Promise<RayuTokens & { user: PublicUser }> {
    return this.auth.loginLocal(body.email, body.password)
  }

  /** Called by the CLI to refresh an expired access token. */
  @Post('cli/refresh')
  refresh(@Body() body: RefreshDto): Promise<RayuTokens> {
    return this.auth.refresh(body.refreshToken)
  }

  /**
   * Local admin login: email + password (no OAuth provider needed).
   * Only works for accounts that have a passwordHash (local admin accounts).
   */
  @Post('admin-login')
  adminLogin(
    @Body() body: LocalLoginDto,
  ): Promise<RayuTokens & { user: PublicUser }> {
    return this.auth.localAdminLogin(body.email, body.password)
  }

  /** Current user profile + active plan. */
  @Get('me')
  @UseGuards(RayuAuthGuard)
  async me(
    @CurrentUser() user: User,
  ): Promise<{ user: PublicUser; status: string }> {
    return { user: this.auth.toPublicUser(user), status: user.status }
  }

  /**
   * Current user's plan entitlements: active plan + resolved feature toggles +
   * usage limits. The CLI can read this later to gate features/usage. All
   * values come from the DB (admin-managed), never hardcoded.
   */
  @Get('me/entitlements')
  @UseGuards(RayuAuthGuard)
  async entitlements(@CurrentUser() user: User) {
    const { plan, currentPeriodEnd } = await this.users.getActiveSubscription(
      user.id,
    )
    const limits = this.plans.getLimits(plan)
    const [allowed, hostedAll, settings, topupBalance] = await Promise.all([
      this.models.findAllowedForPlan(plan.code),
      this.models.findEnabled(),
      this.settings.get(),
      this.users.getTopupBalance(user.id),
    ])
    return {
      plan: {
        code: plan.code,
        name: plan.name,
        priceCents: plan.priceCents,
        availability: plan.availability,
        currentPeriodEnd: currentPeriodEnd ? currentPeriodEnd.toISOString() : null,
      },
      maxDailyTurns: limits.maxDailyTurns ?? null,
      features: this.plans.getResolvedFeatures(plan),
      creditAllowance: {
        creditsPerPeriod: limits.creditsPerPeriod ?? null,
        topUpEnabled: limits.topUpEnabled ?? false,
      },
      creditConfig: {
        baselineCreditsPer1M: settings.baselineCreditsPer1M,
        tokensPerCredit:
          settings.baselineCreditsPer1M > 0
            ? Math.round(1_000_000 / settings.baselineCreditsPer1M)
            : 0,
      },
      topupBalance,
      // The plan-allowed subset the user may actually USE (drives entitlement).
      allowedModels: allowed.map((m) => ({
        code: m.code,
        label: m.label,
        provider: m.provider,
        creditMultiplier: m.creditMultiplier,
        cacheReadCreditMultiplier: m.cacheReadCreditMultiplier,
        cacheWriteCreditMultiplier: m.cacheWriteCreditMultiplier,
      })),
      // The full enabled hosted catalog — shown to EVERY signed-in user so the
      // rayu-hosted provider is always visible (Free sees it but is gated on use;
      // a model is usable iff it also appears in allowedModels above).
      hostedModels: hostedAll.map((m) => ({
        code: m.code,
        label: m.label,
        provider: m.provider,
        creditMultiplier: m.creditMultiplier,
        cacheReadCreditMultiplier: m.cacheReadCreditMultiplier,
        cacheWriteCreditMultiplier: m.cacheWriteCreditMultiplier,
      })),
    }
  }

  /** Recent credit consumption history for the signed-in user. */
  @Get('me/credit-history')
  @UseGuards(RayuAuthGuard)
  creditHistory(@CurrentUser() user: User, @Query('limit') limit?: string) {
    const n = limit ? parseInt(limit, 10) : 50
    // getCreditHistory clamps to [1, 200]; fall back to 50 on a bad value.
    return this.users.getCreditHistory(user.id, Number.isFinite(n) ? n : 50)
  }

  private extractBearer(header: string | undefined): string | null {
    if (!header) return null
    const [scheme, value] = header.split(' ')
    if (scheme?.toLowerCase() !== 'bearer' || !value) return null
    return value.trim()
  }
}
