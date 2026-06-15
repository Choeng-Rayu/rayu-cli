import { Injectable } from '@nestjs/common'
import { Prisma, type Plan } from '@prisma/client'
import type { PlanCode } from '../common/enums'
import { PrismaService } from '../prisma/prisma.service'
import { PLAN_SEED } from './plans.constants'

@Injectable()
export class PlansService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<Plan[]> {
    return this.prisma.plan.findMany({ orderBy: { id: 'asc' } })
  }

  findByCode(code: PlanCode): Promise<Plan | null> {
    return this.prisma.plan.findUnique({ where: { code } })
  }

  /**
   * Idempotently ensure all canonical plans exist with the right
   * availability/price. Safe to run on every boot and from the seed script.
   */
  async seedDefaults(): Promise<Plan[]> {
    for (const seed of PLAN_SEED) {
      const limits: Prisma.InputJsonValue | typeof Prisma.JsonNull =
        seed.limits == null
          ? Prisma.JsonNull
          : (seed.limits as Prisma.InputJsonValue)
      await this.prisma.plan.upsert({
        where: { code: seed.code },
        update: {
          name: seed.name,
          priceCents: seed.priceCents,
          availability: seed.availability,
          limits,
        },
        create: {
          code: seed.code,
          name: seed.name,
          priceCents: seed.priceCents,
          availability: seed.availability,
          limits,
        },
      })
    }
    return this.findAll()
  }
}

