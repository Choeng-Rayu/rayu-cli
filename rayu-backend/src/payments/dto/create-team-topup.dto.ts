import { Type } from 'class-transformer'
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator'
import { TOPUP_MAX_CREDITS } from '../topup-pricing'
import type { CheckoutMethod } from '../payments.service'

/**
 * Query for GET /payments/team/:slug/topup/quote. Same optional `credits` as the
 * individual quote (omitting it asks for the cheapest payable purchase at the
 * current rate, so a dashboard can render a price before the admin picks an
 * amount). The team comes from the route param, not from here.
 */
export class TeamTopupQuoteQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TOPUP_MAX_CREDITS)
  credits?: number
}

/**
 * Buy pay-as-you-go credits FOR A TEAM. The team is addressed by slug so the
 * dashboard can post from the URL it is already on, and only that team's admin
 * may call it (checked against the database in the service).
 *
 * `targetUserId` is the optional "credit this member's own bucket as well" —
 * the shared pool is credited either way, because the pool is the hard cap and a
 * bucket without pool backing is an unspendable promise. The role a member holds
 * is irrelevant here: this is about whose quota goes up, not about permissions.
 *
 * `method` accepts 'stripe' so the team dashboard can offer card purchase for
 * credits as well as plans — the 4th checkout flow. The route still mints a
 * KHQR for 'aba'/'bakong' and a Checkout Session for 'stripe'.
 */
export class CreateTeamTopupDto {
  @IsInt()
  @Min(1)
  @Max(TOPUP_MAX_CREDITS)
  credits!: number

  @IsOptional()
  @IsIn(['aba', 'bakong', 'stripe'])
  method?: CheckoutMethod

  @IsOptional()
  @IsInt()
  @Min(1)
  targetUserId?: number
}
