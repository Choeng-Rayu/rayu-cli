import { IsIn, IsInt, IsOptional, Min } from 'class-validator'
import type { PaymentMethod } from '../payments.service'

export class CreateTopupDto {
  @IsInt()
  @Min(1000)
  credits!: number

  @IsOptional()
  @IsIn(['aba', 'bakong'])
  method?: PaymentMethod
}
