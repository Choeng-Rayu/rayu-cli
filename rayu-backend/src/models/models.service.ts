import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { Prisma, type HostedModel, type Provider } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { MODEL_SEED } from './models.constants'

/**
 * A hosted model with its provider row attached. Everything about ROUTING (wire
 * format, base URL, auth scheme, key env) lives on the provider, so callers that
 * need to know where a model goes must load it this way.
 */
export type HostedModelWithProvider = HostedModel & { provider: Provider }

/** Include clause used by every read path, so provider is always populated. */
const WITH_PROVIDER = { provider: true } as const

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
  // Upstream provider, by providers.id. Base URL / wire format / auth all come
  // from that row, so a model no longer carries any routing config of its own.
  providerId?: number
  upstreamModelId?: string
  inputPricePer1MCents?: number
  outputPricePer1MCents?: number
  // The four admin-entered credit charges (credits per 1M tokens). Used verbatim
  // by the gateway; creditMultiplier is the INPUT charge.
  creditMultiplier?: number
  outputCreditMultiplier?: number
  cacheReadCreditMultiplier?: number
  cacheWriteCreditMultiplier?: number
  allowedPlanCodes?: string[]
  // Context window in tokens. Explicit null clears it back to "unknown", which
  // makes the CLI fall back to its own default for the model.
  contextWindow?: number | null
  supportsReasoning?: boolean
  supportsImage?: boolean
  supportsTools?: boolean
  enabled?: boolean
}

export interface CreateModel extends ModelPatch {
  code: string
}

@Injectable()
export class ModelsService {
  private readonly logger = new Logger(ModelsService.name)

  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<HostedModelWithProvider[]> {
    return this.prisma.hostedModel.findMany({
      orderBy: { id: 'asc' },
      include: WITH_PROVIDER,
    })
  }

  /**
   * All ENABLED hosted models (the catalog shown to every signed-in user).
   * Models of a DISABLED provider are excluded at the database level — that
   * single flag is the provider kill switch (it replaced the gateway's old
   * RAYU_DISABLED_PROVIDERS env var, and the gateway honours the same row).
   */
  findEnabled(): Promise<HostedModelWithProvider[]> {
    return this.prisma.hostedModel.findMany({
      where: { enabled: true, provider: { enabled: true } },
      orderBy: { id: 'asc' },
      include: WITH_PROVIDER,
    })
  }

  findByCode(code: string): Promise<HostedModelWithProvider | null> {
    return this.prisma.hostedModel.findUnique({
      where: { code },
      include: WITH_PROVIDER,
    })
  }

  /** Enabled models whose allowedPlanCodes include the given plan code. */
  async findAllowedForPlan(planCode: string): Promise<HostedModelWithProvider[]> {
    const all = await this.findEnabled()
    return all.filter((m) => this.allowedCodes(m).includes(planCode))
  }

  /** Parse the allowedPlanCodes JSON into a string[]. */
  allowedCodes(model: HostedModel): string[] {
    const v = model.allowedPlanCodes
    return Array.isArray(v) ? (v as string[]) : []
  }

  async create(data: CreateModel): Promise<HostedModelWithProvider> {
    const upstreamModelId = data.upstreamModelId ?? data.code
    if (!isModelFamilyConsistent(data.code, upstreamModelId)) {
      throw new BadRequestException(
        `Model "${data.code}" maps to upstreamModelId "${upstreamModelId}", which is a different model family. ` +
          `A Sonnet code must map to a Sonnet upstream (etc.) so the routed model matches the selected model.`,
      )
    }
    const provider = await this.requireProvider(data.providerId)
    return this.prisma.hostedModel.create({
      data: {
        code: data.code,
        label: data.label ?? data.code,
        providerId: provider.id,
        upstreamModelId,
        inputPricePer1MCents: data.inputPricePer1MCents ?? 0,
        outputPricePer1MCents: data.outputPricePer1MCents ?? 0,
        // Defaults mirror the DB column defaults: output == input (a sane neutral
        // start), cache-read at the 10% weight, cache-write == input.
        creditMultiplier: data.creditMultiplier ?? 1,
        outputCreditMultiplier:
          data.outputCreditMultiplier ?? data.creditMultiplier ?? 1,
        cacheReadCreditMultiplier: data.cacheReadCreditMultiplier ?? 0.1,
        cacheWriteCreditMultiplier:
          data.cacheWriteCreditMultiplier ?? data.creditMultiplier ?? 1,
        allowedPlanCodes: (data.allowedPlanCodes ?? []) as Prisma.InputJsonValue,
        contextWindow: data.contextWindow ?? null,
        // Capabilities default to the PROVIDER's defaults, so adding a model to
        // an image-capable provider doesn't silently start rejecting images.
        supportsReasoning: data.supportsReasoning ?? provider.supportsReasoning,
        supportsImage: data.supportsImage ?? provider.supportsImage,
        // Tool support is the common case, so it defaults ON; the admin turns it
        // off for the rare model that rejects tool definitions.
        supportsTools: data.supportsTools ?? true,
        enabled: data.enabled ?? true,
      },
      include: WITH_PROVIDER,
    })
  }

  async update(
    code: string,
    patch: ModelPatch,
  ): Promise<HostedModelWithProvider> {
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
    if (patch.providerId !== undefined) {
      const provider = await this.requireProvider(patch.providerId)
      data.provider = { connect: { id: provider.id } }
    }
    if (patch.upstreamModelId !== undefined)
      data.upstreamModelId = patch.upstreamModelId
    if (patch.inputPricePer1MCents !== undefined)
      data.inputPricePer1MCents = patch.inputPricePer1MCents
    if (patch.outputPricePer1MCents !== undefined)
      data.outputPricePer1MCents = patch.outputPricePer1MCents
    if (patch.creditMultiplier !== undefined)
      data.creditMultiplier = patch.creditMultiplier
    if (patch.outputCreditMultiplier !== undefined)
      data.outputCreditMultiplier = patch.outputCreditMultiplier
    if (patch.cacheReadCreditMultiplier !== undefined)
      data.cacheReadCreditMultiplier = patch.cacheReadCreditMultiplier
    if (patch.cacheWriteCreditMultiplier !== undefined)
      data.cacheWriteCreditMultiplier = patch.cacheWriteCreditMultiplier
    if (patch.allowedPlanCodes !== undefined)
      data.allowedPlanCodes = patch.allowedPlanCodes as Prisma.InputJsonValue
    if (patch.contextWindow !== undefined) data.contextWindow = patch.contextWindow
    if (patch.supportsReasoning !== undefined)
      data.supportsReasoning = patch.supportsReasoning
    if (patch.supportsImage !== undefined) data.supportsImage = patch.supportsImage
    if (patch.supportsTools !== undefined) data.supportsTools = patch.supportsTools
    if (patch.enabled !== undefined) data.enabled = patch.enabled
    return this.prisma.hostedModel.update({
      where: { code },
      data,
      include: WITH_PROVIDER,
    })
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
   * provider), the routing fields — providerId and upstreamModelId — are
   * reconciled to the seed on boot, because a provider change invalidates the
   * old upstream model id too.
   *
   * This is what makes a provider switch in MODEL_SEED actually take effect on
   * an EXISTING database: the plain create-if-missing seed left old rows
   * pointing at the old upstream, so the gateway (which routes off the model's
   * provider row + upstreamModelId) kept hitting the old provider. The reconcile
   * only triggers on a provider change, so an admin who merely tuned the
   * upstream model id/tag for the SAME provider is untouched.
   *
   * A seed entry naming a provider that does not exist is skipped with a warning
   * rather than crashing boot — the provider registry is admin-editable, so a
   * renamed/deleted provider must not take the whole service down.
   */
  async seedDefaults(): Promise<void> {
    for (const m of MODEL_SEED) {
      const provider = await this.prisma.provider.findUnique({
        where: { name: m.providerName },
      })
      if (!provider) {
        this.logger.warn(
          `seed skipped for model "${m.code}": provider "${m.providerName}" is not in the registry. ` +
            `Add it in the admin dashboard (or restore its name) to seed this model.`,
        )
        continue
      }
      const existing = await this.findByCode(m.code)
      if (existing) {
        if (existing.providerId !== provider.id) {
          await this.prisma.hostedModel.update({
            where: { code: m.code },
            data: {
              providerId: provider.id,
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
          providerId: provider.id,
          upstreamModelId: m.upstreamModelId,
          inputPricePer1MCents: m.inputPricePer1MCents,
          outputPricePer1MCents: m.outputPricePer1MCents,
          creditMultiplier: m.creditMultiplier,
          outputCreditMultiplier: m.outputCreditMultiplier ?? m.creditMultiplier,
          cacheReadCreditMultiplier: m.cacheReadCreditMultiplier ?? 0.1,
          cacheWriteCreditMultiplier: m.cacheWriteCreditMultiplier ?? m.creditMultiplier,
          allowedPlanCodes: m.allowedPlanCodes as Prisma.InputJsonValue,
          contextWindow: m.contextWindow ?? null,
          supportsReasoning: m.supportsReasoning,
          supportsImage: m.supportsImage,
          supportsTools: m.supportsTools ?? true,
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

  /**
   * Resolve a provider id from an admin request. A model MUST belong to a
   * registered provider — that row is what tells the gateway the wire format,
   * base URL, auth scheme, and key env, so an unknown id has to be rejected
   * rather than defaulted (a silent default would route traffic somewhere the
   * admin did not choose).
   */
  private async requireProvider(providerId: number | undefined): Promise<Provider> {
    if (providerId === undefined || providerId === null) {
      throw new BadRequestException(
        'providerId is required: pick the upstream provider this model routes to',
      )
    }
    const provider = await this.prisma.provider.findUnique({
      where: { id: providerId },
    })
    if (!provider) {
      throw new BadRequestException(
        `Unknown providerId ${providerId}. Create the provider first in the admin provider registry.`,
      )
    }
    return provider
  }
}
