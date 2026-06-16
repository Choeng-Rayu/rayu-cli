import { IsIn, IsNotEmpty } from 'class-validator'
import { PLAN_CODES, type PlanCode } from '../../common/enums'

export class CreateKhqrDto {
  @IsNotEmpty()
  @IsIn(PLAN_CODES as unknown as string[])
  planCode!: PlanCode
}
