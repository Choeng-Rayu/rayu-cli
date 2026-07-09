import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator'
import { PLAN_CODES, type PlanCode } from '../../common/enums'

/** Preview a promo code's discounted price, or claim a $0 (100%-off) plan. */
export class PromoActionDto {
  @IsNotEmpty()
  @IsIn(PLAN_CODES as unknown as string[])
  planCode!: PlanCode

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  code!: string
}
