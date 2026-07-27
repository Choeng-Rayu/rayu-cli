import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator'
import type { PaymentMethod } from '../payments.service'

export class CreateTopupDto {
  // A credit amount, not a dollar amount: the buyer picks what they need and the
  // server prices it from creditsPerDollar. The dollar floor (minTopupCents) is
  // enforced in the service, where the rate is known.
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  credits!: number

  @IsOptional()
  @IsIn(['aba', 'bakong'])
  method?: PaymentMethod
}
