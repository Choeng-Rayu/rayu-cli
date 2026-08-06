import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import type { User } from '@prisma/client'
import { RayuAuthGuard } from '../auth/rayu-auth.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { CreateKhqrDto } from './dto/create-khqr.dto'
import { CreateTeamKhqrDto } from './dto/create-team-khqr.dto'
import {
  CreateTeamTopupDto,
  TeamTopupQuoteQueryDto,
} from './dto/create-team-topup.dto'
import { CreateTopupDto } from './dto/create-topup.dto'
import { TopupQuoteQueryDto } from './dto/topup-quote-query.dto'
import { PromoActionDto } from './dto/promo-action.dto'
import { PaymentsService } from './payments.service'

@Controller('payments')
@UseGuards(RayuAuthGuard)
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('khqr')
  createKhqr(@CurrentUser() user: User, @Body() body: CreateKhqrDto) {
    return this.payments.createKhqr(
      user.id,
      body.planCode,
      body.method,
      body.promoCode,
    )
  }

  /**
   * Team checkout: buy an ORG-owned subscription. Only the team's admin may call
   * it (enforced in the service against the database, not the JWT claim). The
   * resulting payment carries `organizationId`, which is what makes confirmation
   * seed the team's shared credit pool instead of the payer's personal plan.
   */
  @Post('team-khqr')
  createTeamKhqr(@CurrentUser() user: User, @Body() body: CreateTeamKhqrDto) {
    return this.payments.createTeamKhqr(
      user.id,
      body.slug,
      body.planCode,
      body.method,
    )
  }

  // Preview a plan's price with a promo code (does not create a payment). The
  // response's `isFree` tells the UI to show a Claim button instead of a QR.
  @Post('promo/preview')  previewPromo(@CurrentUser() user: User, @Body() body: PromoActionDto) {
    return this.payments.previewPromo(user.id, body.planCode, body.code)
  }

  // Claim a $0 (100%-off) plan with a promo code — activates immediately, no QR.
  @Post('promo/claim')
  claimPromo(@CurrentUser() user: User, @Body() body: PromoActionDto) {
    return this.payments.claimFreePromo(user.id, body.planCode, body.code)
  }

  /**
   * Live top-up price quote — NO payment is created. The single source of truth
   * for the pricing a client shows: `enabled`, `credits`, `amountCents`,
   * `minCredits`, `maxCredits`, `rateCreditsPerDollar` and `minTopupCents` are
   * all computed from the current AppSettings row on every request, so an admin
   * rate change is reflected immediately. Clients must never compute a price
   * from a rate of their own.
   *
   * Declared BEFORE the ':id/...' routes it cannot collide with (two segments vs
   * one), and kept next to the create endpoint it prices.
   */
  @Get('topup/quote')
  topupQuote(@Query() query: TopupQuoteQueryDto) {
    return this.payments.getTopupQuote(query.credits)
  }

  /**
   * Price a TEAM credit purchase. Same rate as the individual quote (one shared
   * pricing module), plus the two facts that are specific to a team: whether
   * this team is allowed to buy credits at all, and when they expire — purchased
   * credits live in the pool's current period, so the buyer sees `expiresAt` and
   * `daysLeft` before paying rather than discovering it at renewal.
   *
   * Admin-only, enforced in the service against the database.
   */
  @Get('team/:slug/topup/quote')
  teamTopupQuote(
    @CurrentUser() user: User,
    @Param('slug') slug: string,
    @Query() query: TeamTopupQuoteQueryDto,
  ) {
    return this.payments.getTeamTopupQuote(user.id, slug, query.credits)
  }

  /**
   * Create a top-up on any rail (ABA / Bakong KHQR / Stripe when enabled). All
   * rails share one pricing + grant path; `topup-khqr` below is the original
   * KHQR-only alias, kept for existing clients.
   */
  @Post('topup')
  createTopup(@CurrentUser() user: User, @Body() body: CreateTopupDto) {
    return this.payments.createTopupPayment(user.id, body.credits, body.method)
  }

  /**
   * Buy pay-as-you-go credits for a TEAM: one KHQR that raises the team's shared
   * pool for the current period once paid. Admin-only (checked in the service
   * against the database), and refused unless the team holds an active team plan
   * that allows top-ups — credits are an add-on to a plan, not a substitute for
   * one, because the PLAN is what grants members model access.
   *
   * Optional `targetUserId` additionally raises that member's own quota. The
   * shared pool goes up either way: it is the hard cap, so a bucket without pool
   * backing would be a number nobody could spend.
   */
  @Post('team/:slug/topup')
  createTeamTopup(
    @CurrentUser() user: User,
    @Param('slug') slug: string,
    @Body() body: CreateTeamTopupDto,
  ) {
    return this.payments.createTeamTopup(
      user.id,
      slug,
      body.credits,
      body.method,
      body.targetUserId,
    )
  }

  @Post('topup-khqr')
  createTopupKhqr(@CurrentUser() user: User, @Body() body: CreateTopupDto) {
    return this.payments.createTopupPayment(user.id, body.credits, body.method)
  }

  @Get('mine')
  mine(
    @CurrentUser() user: User,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
  ) {
    return this.payments.getUserPayments(
      user.id,
      parseInt(page, 10) || 1,
      Math.min(parseInt(pageSize, 10) || 20, 100),
    )
  }

  @Get('stripe/enabled')
  stripeEnabled() {
    // The card rail's availability is env-gated (STRIPE_ENABLED); exposed so the
    // web clients can hide the "Pay with card" button on deployments where the
    // rail is off, rather than discovering it via a 501 on the create call.
    return { enabled: this.payments.isStripeRailEnabled() }
  }

  @Get(':id/status')
  status(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
  ) {
    return this.payments.checkStatus(id, user.id)
  }

  @Post(':id/renew')
  renew(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
  ) {
    return this.payments.renewPayment(id, user.id)
  }

  @Post(':id/cancel')
  cancel(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
  ) {
    return this.payments.cancelPayment(id, user.id)
  }
}
