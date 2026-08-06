import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator'
import { PLAN_CODES, type PlanCode } from '../../common/enums'
import type { CheckoutMethod } from '../payments.service'

export class CreateKhqrDto {
  @IsNotEmpty()
  @IsIn(PLAN_CODES as unknown as string[])
  planCode!: PlanCode

  // The route name (/payments/khqr) is a legacy misnomer — it now mints a KHQR
  // for aba/bakong OR a hosted Stripe Checkout Session for 'stripe'. Kept for
  // client stability; the response is a discriminated union on `method`.
  @IsOptional()
  @IsIn(['aba', 'bakong', 'stripe'])
  method?: CheckoutMethod

  /** Optional promo/discount code applied to the plan price. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  promoCode?: string
}
