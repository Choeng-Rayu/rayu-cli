import { Type } from 'class-transformer'
import { IsInt, IsOptional, Max, Min } from 'class-validator'
import { TOPUP_MAX_CREDITS } from '../topup-pricing'

/**
 * Query for GET /payments/topup/quote. `credits` is optional: omitting it asks
 * for the cheapest payable purchase at the current rate, which is what a client
 * needs to render the top-up screen before the user has picked an amount.
 */
export class TopupQuoteQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TOPUP_MAX_CREDITS)
  credits?: number
}
