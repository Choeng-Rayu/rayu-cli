import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common'
import { CurrentUser } from './current-user.decorator'
import type { User } from '@prisma/client'
import { PlansService } from '../plans/plans.service'
import { AuthService, PublicUser, RayuTokens } from './auth.service'
import { ExchangeDto, RefreshDto, TokenDto } from './dto/auth.dto'
import { RayuAuthGuard } from './rayu-auth.guard'

@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly plans: PlansService,
  ) {}

  /**
   * Called by the website's /cli-login bridge. The signed-in user's Clerk
   * session token is passed in the Authorization header; the CLI's CSRF state
   * is in the body. Returns a one-time code.
   */
  @Post('cli/exchange')
  async exchange(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: ExchangeDto,
  ): Promise<{ code: string }> {
    const clerkToken = this.extractBearer(authorization)
    if (!clerkToken) {
      throw new UnauthorizedException('Missing Clerk session token')
    }
    return this.auth.exchangeClerkToken(clerkToken, body.state)
  }

  /** Called by the CLI to redeem the one-time code for Rayu tokens. */
  @Post('cli/token')
  redeem(@Body() body: TokenDto): Promise<RayuTokens & { user: PublicUser }> {
    return this.auth.redeemCode(body.code)
  }

  /**
   * Browser login for the website/dashboard: exchange a Clerk session token
   * (Authorization header) for Rayu tokens directly.
   */
  @Post('web/session')
  async webSession(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<RayuTokens & { user: PublicUser }> {
    const clerkToken = this.extractBearer(authorization)
    if (!clerkToken) {
      throw new UnauthorizedException('Missing Clerk session token')
    }
    return this.auth.webSession(clerkToken)
  }

  /** Called by the CLI to refresh an expired access token. */
  @Post('cli/refresh')
  refresh(@Body() body: RefreshDto): Promise<RayuTokens> {
    return this.auth.refresh(body.refreshToken)
  }

  /** Current user profile + active plan. */
  @Get('me')
  @UseGuards(RayuAuthGuard)
  async me(
    @CurrentUser() user: User,
  ): Promise<{ user: PublicUser; status: string }> {
    return { user: this.auth.toPublicUser(user), status: user.status }
  }

  private extractBearer(header: string | undefined): string | null {
    if (!header) return null
    const [scheme, value] = header.split(' ')
    if (scheme?.toLowerCase() !== 'bearer' || !value) return null
    return value.trim()
  }
}
