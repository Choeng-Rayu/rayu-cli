import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { Prisma, type HostedModel } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { MODEL_SEED } from './models.constants'

// Providers turned OFF via RAYU_DISABLED_PROVIDERS (comma-separated) are hidden
// from USERS — the entitlement + user catalog exclude their models — mirroring
// the gateway's zero-code provider disable (both read the same env). The admin
// catalog (findAll) still shows everything so it stays manageable. Read once.
const DISABLED_PROVIDERS = new Set(
  (process.env.RAYU_DISABLED_PROVIDERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)

/** Claude model families used for the catalog family-consistency guard. */
type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'other'

function modelFamilyOf(id: string): ModelFamily {
  const m = id.toLowerCase()
  if (m.includes('opus')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('haiku')) return 'haiku'
  return 'other'
}

/**
 * A hosted-model row is family-consistent when its `code` and `upstreamModelId`
 * resolve to the same Claude family. When either side is 'other' (a non-Claude
 * model such as deepseek/glm/kimi, or an opaque upstream id) the mapping is
 * allowed — we only ever reject a DEFINITE cross-family mapping (e.g. a
 * "claude-sonnet-*" code pointed at a "…opus…" upstream), which is the catalog
 * analogue of the CLI's model-fidelity guarantee.
 */
export function isModelFamilyConsistent(
  code: string,
  upstreamModelId: string,
): boolean {
  const cf = modelFamilyOf(code)
  const uf = modelFamilyOf(upstreamModelId)
  if (cf === 'other' || uf === 'other') return true
  return cf === uf
}

export interface ModelPatch {
  label?: string
  provider?: string
  upstreamBaseUrl?: string
  upstreamModelId?: string
  inputPricePer1MCents?: number
  outputPricePer1MCents?: number
  creditMultiplier?: number
  // Allow explicit null (= "not configured", the gateway falls back to its
  // own default) so the admin UI can clear the field back to inherited
  // behavior — matches ModelFieldsDto's cacheRead/cacheWriteCreditMultiplier.
  cacheReadCreditMultiplier?: number | null
  cacheWriteCreditMultiplier?: number | null
  allowedPlanCodes?: string[]
  enabled?: boolean
}

export interface CreateModel extends ModelPatch {
  code: string
}

@Injectable()
export class ModelsService {
  private readonly logger = new Logger(ModelsService.name)

  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<HostedModel[]> {
    return this.prisma.hostedModel.findMany({ orderBy: { id: 'asc' } })
  }

  /** All ENABLED hosted models (the catalog shown to every signed-in user). */
  async findEnabled(): Promise<HostedModel[]> {
    const models = await this.prisma.hostedModel.findMany({
      where: { enabled: true },
      orderBy: { id: 'asc' },
    })
    return models.filter((m) => !DISABLED_PROVIDERS.has(m.provider))
  }

  findByCode(code: string): Promise<HostedModel | null> {
    return this.prisma.hostedModel.findUnique({ where: { code } })
  }

  /** Enabled models whose allowedPlanCodes include the given plan code. */
  async findAllowedForPlan(planCode: string): Promise<HostedModel[]> {
    const all = await this.prisma.hostedModel.findMany({
      where: { enabled: true },
      orderBy: { id: 'asc' },
    })
    return all.filter(
      (m) =>
        !DISABLED_PROVIDERS.has(m.provider) &&
        this.allowedCodes(m).includes(planCode),
    )
  }

  /** Parse the allowedPlanCodes JSON into a string[]. */
  allowedCodes(model: HostedModel): string[] {
    const v = model.allowedPlanCodes
    return Array.isArray(v) ? (v as string[]) : []
  }

  async create(data: CreateModel): Promise<HostedModel> {
    const upstreamModelId = data.upstreamModelId ?? data.code
    if (!isModelFamilyConsistent(data.code, upstreamModelId)) {
      throw new BadRequestException(
        `Model "${data.code}" maps to upstreamModelId "${upstreamModelId}", which is a different model family. ` +
          `A Sonnet code must map to a Sonnet upstream (etc.) so the routed model matches the selected model.`,
      )
    }
    return this.prisma.hostedModel.create({
      data: {
        code: data.code,
        label: data.label ?? data.code,
        provider: data.provider ?? 'deepseek',
        upstreamBaseUrl: data.upstreamBaseUrl ?? '',
        upstreamModelId,
        inputPricePer1MCents: data.inputPricePer1MCents ?? 0,
        outputPricePer1MCents: data.outputPricePer1MCents ?? 0,
        creditMultiplier: data.creditMultiplier ?? 1,
        cacheReadCreditMultiplier: data.cacheReadCreditMultiplier ?? null,
        cacheWriteCreditMultiplier: data.cacheWriteCreditMultiplier ?? null,
        allowedPlanCodes: (data.allowedPlanCodes ?? []) as Prisma.InputJsonValue,
        enabled: data.enabled ?? true,
      },
    })
  }

  async update(code: string, patch: ModelPatch): Promise<HostedModel> {
    const existing = await this.findByCode(code)
    if (!existing) throw new NotFoundException(`Unknown model: ${code}`)
    // Guard the routing field: the effective upstreamModelId must stay in the
    // same model family as the code, so an admin edit can't repoint a Sonnet
    // code at an Opus upstream (the catalog analogue of model fidelity).
    const effectiveUpstream = patch.upstreamModelId ?? existing.upstreamModelId
    if (!isModelFamilyConsistent(code, effectiveUpstream)) {
      throw new BadRequestException(
        `Model "${code}" cannot map to upstreamModelId "${effectiveUpstream}": different model family. ` +
          `Keep the upstream in the same family as the model code.`,
      )
    }
    const data: Prisma.HostedModelUpdateInput = {}
    if (patch.label !== undefined) data.label = patch.label
    if (patch.provider !== undefined) data.provider = patch.provider
    if (patch.upstreamBaseUrl !== undefined)
      data.upstreamBaseUrl = patch.upstreamBaseUrl
    if (patch.upstreamModelId !== undefined)
      data.upstreamModelId = patch.upstreamModelId
    if (patch.inputPricePer1MCents !== undefined)
      data.inputPricePer1MCents = patch.inputPricePer1MCents
    if (patch.outputPricePer1MCents !== undefined)
      data.outputPricePer1MCents = patch.outputPricePer1MCents
    if (patch.creditMultiplier !== undefined)
      data.creditMultiplier = patch.creditMultiplier
    if (patch.cacheReadCreditMultiplier !== undefined)
      data.cacheReadCreditMultiplier = patch.cacheReadCreditMultiplier
    if (patch.cacheWriteCreditMultiplier !== undefined)
      data.cacheWriteCreditMultiplier = patch.cacheWriteCreditMultiplier
    if (patch.allowedPlanCodes !== undefined)
      data.allowedPlanCodes = patch.allowedPlanCodes as Prisma.InputJsonValue
    if (patch.enabled !== undefined) data.enabled = patch.enabled
    return this.prisma.hostedModel.update({ where: { code }, data })
  }

  async remove(code: string): Promise<{ deleted: true }> {
    const existing = await this.findByCode(code)
    if (!existing) throw new NotFoundException(`Unknown model: ${code}`)
    await this.prisma.hostedModel.delete({ where: { code } })
    return { deleted: true }
  }

  /**
   * Create-if-missing seed + NON-DESTRUCTIVE routing reconciliation.
   *
   * Business fields (prices, creditMultiplier, allowedPlanCodes, enabled) are
   * NEVER overwritten for an existing model — they are admin-owned. But when the
   * seed re-points a model at a DIFFERENT upstream PROVIDER than the stored row
   * (e.g. DeepSeek V4 moving from Ollama Cloud back onto the official `deepseek`
   * Anthropic-compatible API), the ROUTING fields — provider, upstreamBaseUrl,
   * upstreamModelId — are
   * reconciled to the seed on boot. A provider change invalidates the old base
   * URL + upstream model id, so all three move together.
   *
   * This is what makes a provider switch in MODEL_SEED actually take effect on
   * an EXISTING database: the plain create-if-missing seed left old rows
   * pointing at the old upstream, so the gateway (which routes purely off
   * hosted_models.provider/upstreamBaseUrl/upstreamModelId) kept hitting the old
   * provider. The reconcile only triggers on a provider change, so an admin who
   * merely tuned the upstream model id/tag for the SAME provider is untouched.
   */
  async seedDefaults(): Promise<void> {
    for (const m of MODEL_SEED) {
      const existing = await this.findByCode(m.code)
      if (existing) {
        if (existing.provider !== m.provider) {
          await this.prisma.hostedModel.update({
            where: { code: m.code },
            data: {
              provider: m.provider,
              upstreamBaseUrl: m.upstreamBaseUrl,
              upstreamModelId: m.upstreamModelId,
            },
          })
        }
        continue
      }
      await this.prisma.hostedModel.create({
        data: {
          code: m.code,
          label: m.label,
          provider: m.provider,
          upstreamBaseUrl: m.upstreamBaseUrl,
          upstreamModelId: m.upstreamModelId,
          inputPricePer1MCents: m.inputPricePer1MCents,
          outputPricePer1MCents: m.outputPricePer1MCents,
          creditMultiplier: m.creditMultiplier,
          cacheReadCreditMultiplier: m.cacheReadCreditMultiplier ?? null,
          cacheWriteCreditMultiplier: m.cacheWriteCreditMultiplier ?? null,
          allowedPlanCodes: m.allowedPlanCodes as Prisma.InputJsonValue,
          enabled: m.enabled,
        },
      })
    }
    // Non-destructive boot audit: flag any existing row whose code/upstream
    // cross model families so operators can fix a mis-mapped catalog entry.
    await this.auditModelFamilyConsistency()
  }

  /**
   * Boot-time audit: WARN (never mutate) about any EXISTING hosted_models row
   * whose code and upstreamModelId are in different Claude model families — e.g.
   * a row that predates the create/update guard or was edited directly in the
   * DB. Admin-owned fields are left untouched; the operator fixes it in the
   * dashboard.
   */
  async auditModelFamilyConsistency(): Promise<void> {
    const all = await this.findAll()
    for (const m of all) {
      if (!isModelFamilyConsistent(m.code, m.upstreamModelId)) {
        this.logger.warn(
          `hosted model "${m.code}" maps to upstreamModelId "${m.upstreamModelId}" of a different ` +
            `model family — requests for "${m.code}" will route to the wrong model. ` +
            `Fix it in the admin model catalog.`,
        )
      }
    }
  }
}
