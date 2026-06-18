import { Injectable, NotFoundException } from '@nestjs/common'
import { Prisma, type HostedModel } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { MODEL_SEED } from './models.constants'

export interface ModelPatch {
  label?: string
  provider?: string
  upstreamBaseUrl?: string
  upstreamModelId?: string
  inputPricePer1MCents?: number
  outputPricePer1MCents?: number
  creditMultiplier?: number
  allowedPlanCodes?: string[]
  enabled?: boolean
}

export interface CreateModel extends ModelPatch {
  code: string
}

@Injectable()
export class ModelsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<HostedModel[]> {
    return this.prisma.hostedModel.findMany({ orderBy: { id: 'asc' } })
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
    return all.filter((m) => this.allowedCodes(m).includes(planCode))
  }

  /** Parse the allowedPlanCodes JSON into a string[]. */
  allowedCodes(model: HostedModel): string[] {
    const v = model.allowedPlanCodes
    return Array.isArray(v) ? (v as string[]) : []
  }

  async create(data: CreateModel): Promise<HostedModel> {
    return this.prisma.hostedModel.create({
      data: {
        code: data.code,
        label: data.label ?? data.code,
        provider: data.provider ?? 'deepseek',
        upstreamBaseUrl: data.upstreamBaseUrl ?? '',
        upstreamModelId: data.upstreamModelId ?? data.code,
        inputPricePer1MCents: data.inputPricePer1MCents ?? 0,
        outputPricePer1MCents: data.outputPricePer1MCents ?? 0,
        creditMultiplier: data.creditMultiplier ?? 1,
        allowedPlanCodes: (data.allowedPlanCodes ?? []) as Prisma.InputJsonValue,
        enabled: data.enabled ?? true,
      },
    })
  }

  async update(code: string, patch: ModelPatch): Promise<HostedModel> {
    const existing = await this.findByCode(code)
    if (!existing) throw new NotFoundException(`Unknown model: ${code}`)
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

  /** Create-if-missing seed; never overwrites admin-edited models. */
  async seedDefaults(): Promise<void> {
    for (const m of MODEL_SEED) {
      const existing = await this.findByCode(m.code)
      if (existing) continue
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
          allowedPlanCodes: m.allowedPlanCodes as Prisma.InputJsonValue,
          enabled: m.enabled,
        },
      })
    }
  }
}
