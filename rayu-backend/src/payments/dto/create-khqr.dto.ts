import { IsIn, IsNotEmpty, IsOptional } from 'class-validator'
import { PLAN_CODES, type PlanCode } from '../../common/enums'
import type { PaymentMethod } from '../payments.service'

export class CreateKhqrDto {
  @IsNotEmpty()
  @IsIn(PLAN_CODES as unknown as string[])
  planCode!: PlanCode

  @IsOptional()
  @IsIn(['aba', 'bakong'])
  method?: PaymentMethod
}
