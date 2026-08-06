import { IsIn, IsOptional, IsString, Matches } from 'class-validator'
import { PLAN_CODES, type PlanCode } from '../../common/enums'
import type { CheckoutMethod } from '../payments.service'

/**
 * Team checkout input. The team is addressed by SLUG (not id) so the web
 * dashboard can post straight from the URL it is already on, and the plan must
 * be one flagged `isTeamPlan` — verified in the service, since a plan's team
 * flag is admin-editable data rather than something a DTO can know.
 *
 * The route name (/payments/team-khqr) is a legacy misnomer — 'stripe' mints a
 * hosted Checkout Session instead of a KHQR. Kept for client stability; the
 * response is a discriminated union on `method`.
 */
export class CreateTeamKhqrDto {
  @IsString()
  @Matches(/^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/, {
    message: 'invalid team slug',
  })
  slug!: string

  @IsIn(PLAN_CODES as unknown as string[])
  planCode!: PlanCode

  @IsOptional()
  @IsIn(['aba', 'bakong', 'stripe'])
  method?: CheckoutMethod
}
