import { Controller, Get } from '@nestjs/common'
import type { Plan } from '@prisma/client'
import { PlansService } from './plans.service'

@Controller('plans')
export class PlansController {
  constructor(private readonly plansService: PlansService) {}

  // Public: the website renders the plan catalog from this endpoint.
  @Get()
  findAll(): Promise<Plan[]> {
    return this.plansService.findAll()
  }
}
