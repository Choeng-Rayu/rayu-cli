import { Injectable, NotFoundException } from '@nestjs/common'
import { Prisma, type Plan } from '@prisma/client'
import type { PlanAvailability, PlanCode } from '../common/enums'
import {
  type FeatureEntitlements,
  type FeatureKey,
  backfillMissingFeatures,
  resolveEntitlements,
} from '../common/features'
import { PrismaService } from '../prisma/prisma.service'
import { PLAN_SEED } from './plans.constants'

export interface PlanLimits {
  bringYourOwnKey?: boolean
  contactSales?: boolean
  maxDailyTurns?: number | null
  features?: Record<string, { enabled: boolean; limit?: number | null }>
  // Paid-plan credit allowance: a per-billing-period balance (credits) consumed
  // by the gateway. 1 credit = (1e6 / baselineCreditsPer1M) tokens. Depletes
  // over the 30-day period and refills on renewal/top-up — no weekly reset.
  creditsPerPeriod?: number | null
  topUpEnabled?: boolean
  // Legacy windowed fields (superseded by creditsPerPeriod; kept optional so
  // older limits JSON still parses). No longer enforced.
  creditsPerWeek?: number | null
  creditsPer5h?: number | null
  [key: string]: unknown
}

export interface PlanPatch {
  name?: string
  priceCents?: number
  availability?: PlanAvailability
  maxDailyTurns?: number | null
  features?: FeatureEntitlements
  creditsPerPeriod?: number | null
  topUpEnabled?: boolean
}

@Injectable()
export class PlansService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<Plan[]> {
    return this.prisma.plan.findMany({ orderBy: { id: 'asc' } })
  }

  findByCode(code: PlanCode | string): Promise<Plan | null> {
    return this.prisma.plan.findUnique({ where: { code } })
  }

  /** Parse a plan's limits JSON into a typed object. */
  getLimits(plan: Plan): PlanLimits {
    const l = plan.limits
    return l && typeof l === 'object' ? (l as PlanLimits) : {}
  }

  /** Resolve a plan's feature entitlements (complete map across the catalog). */
  getResolvedFeatures(
    plan: Plan,
  ): Record<FeatureKey, { enabled: boolean; limit?: number | null }> {
    return resolveEntitlements(this.getLimits(plan).features)
  }

  /**
   * Idempotently ensure each canonical plan EXISTS — create-if-missing — and
   * backfill any newly-added catalog features onto plans that already exist.
   *
   * Creation is unchanged. The backfill is NON-DESTRUCTIVE: for a pre-existing
   * plan it only fills feature keys that are ABSENT from its stored
   * `limits.features` (using that plan's seed defaults), so super-admin edits
   * (price, availability, feature toggles, limits) are never overwritten. This
   * is what lets a feature added to the catalog AFTER launch (e.g.
   * `multi_api_keys`) reach existing paid plans with its intended default
   * (paid → enabled, free → disabled) instead of resolving to disabled forever.
   * The DB remains the source of truth; PLAN_SEED only provides defaults.
   */
  async seedDefaults(): Promise<Plan[]> {
    for (const seed of PLAN_SEED) {
      const existing = await this.prisma.plan.findUnique({
        where: { code: seed.code },
      })
      if (existing) {
        await this.backfillPlanFeatures(existing, seed)
        continue
      }
      const limits: Prisma.InputJsonValue | typeof Prisma.JsonNull =
        seed.limits == null
          ? Prisma.JsonNull
          : (seed.limits as Prisma.InputJsonValue)
      await this.prisma.plan.create({
        data: {
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

  /**
   * Backfill catalog features missing from an existing plan's stored
   * entitlements, using the plan's seed defaults. Writes only when a key was
   * actually added, so it's a no-op on every boot after the first.
   */
  private async backfillPlanFeatures(
    plan: Plan,
    seed: (typeof PLAN_SEED)[number],
  ): Promise<void> {
    const seedFeatures = ((seed.limits?.features as FeatureEntitlements | undefined) ??
      {}) as FeatureEntitlements
    const limits = this.getLimits(plan)
    const { features, added } = backfillMissingFeatures(
      limits.features,
      seedFeatures,
    )
    if (added.length === 0) return
    limits.features = features
    await this.prisma.plan.update({
      where: { code: plan.code },
      data: { limits: limits as Prisma.InputJsonValue },
    })
  }

  /**
   * Admin update of a plan's business logic. Merges into the existing limits
   * JSON so unrelated keys are preserved. Only provided fields are changed.
   */
  async updatePlan(code: string, patch: PlanPatch): Promise<Plan> {
    const existing = await this.findByCode(code)
    if (!existing) throw new NotFoundException(`Unknown plan: ${code}`)

    const limits = this.getLimits(existing)
    if (patch.maxDailyTurns !== undefined) {
      limits.maxDailyTurns = patch.maxDailyTurns
    }
    if (patch.creditsPerPeriod !== undefined) {
      limits.creditsPerPeriod = patch.creditsPerPeriod
    }
    if (patch.topUpEnabled !== undefined) {
      limits.topUpEnabled = patch.topUpEnabled
    }
    if (patch.features !== undefined) {
      const current = (limits.features ?? {}) as Record<
        string,
        { enabled: boolean; limit?: number | null }
      >
      // Merge per-feature so a partial patch only changes the given features.
      limits.features = { ...current, ...patch.features }
    }

    const data: Prisma.PlanUpdateInput = {
      limits: limits as Prisma.InputJsonValue,
    }
    if (patch.name !== undefined) data.name = patch.name
    if (patch.priceCents !== undefined) data.priceCents = patch.priceCents
    if (patch.availability !== undefined) data.availability = patch.availability

    return this.prisma.plan.update({ where: { code }, data })
  }
}
