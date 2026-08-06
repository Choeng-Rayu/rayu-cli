import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator'
import type { TopupMethod } from '../payments.service'
import { TOPUP_MAX_CREDITS } from '../topup-pricing'

export class CreateTopupDto {
  // A credit amount, not a dollar amount: the buyer picks what they need and the
  // server prices it from creditsPerDollar. The dollar floor (minTopupCents) is
  // enforced in the service, where the rate is known.
  @IsInt()
  @Min(1)
  @Max(TOPUP_MAX_CREDITS)
  credits!: number

  // Rail to pay on. 'stripe' is accepted by validation so clients are stable
  // once Checkout lands; the service answers 501 until it is enabled.
  @IsOptional()
  @IsIn(['aba', 'bakong', 'stripe'])
  method?: TopupMethod
}
