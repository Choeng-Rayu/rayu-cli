import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { Prisma, type MediaModel } from '@prisma/client'
import {
  MEDIA_BACKENDS,
  MEDIA_CAPABILITIES,
  MEDIA_FAMILIES,
  MEDIA_TYPES,
  type MediaBackend,
  type MediaCapability,
  type MediaFamily,
  type MediaType,
} from '../common/enums'
import { PrismaService } from '../prisma/prisma.service'
import { MEDIA_MODEL_SEED } from './media-models.constants'

/**
 * Admin-owned catalog of IMAGE- and VIDEO-generation models.
 *
 * This is the SOURCE OF TRUTH for the CLI's image/video model lists: the CLI
 * reads it through the gateway (`GET /v1/models?media=image|video`) and keeps no
 * hardcoded registry, so adding a model is a row here and nothing else.
 *
 * Metadata only — no credential, no gateway-followed URL, no billing rate.
 */
export interface MediaModelPatch {
  label?: string
  mediaType?: MediaType
  capabilities?: MediaCapability[]
  backend?: MediaBackend
  family?: MediaFamily
  /** Explicit null clears it. */
  nvcfFunctionId?: string | null
  estimatedSeconds?: number | null
  defaultParams?: Record<string, unknown> | null
  allowedPlanCodes?: string[]
  isDefault?: boolean
  sortOrder?: number
  enabled?: boolean
}

export interface CreateMediaModel extends MediaModelPatch {
  code: string
}

/** Parse the capabilities JSON column into a validated string array. */
export function mediaCapabilitiesOf(model: MediaModel): MediaCapability[] {
  const v = model.capabilities
  if (!Array.isArray(v)) return []
  return v.filter((c): c is MediaCapability =>
    (MEDIA_CAPABILITIES as readonly string[]).includes(c as string),
  )
}

/** Parse the allowedPlanCodes JSON column into a string array. */
export function mediaAllowedPlanCodes(model: MediaModel): string[] {
  const v = model.allowedPlanCodes
  return Array.isArray(v) ? (v as string[]) : []
}

/**
 * Capabilities that make sense for a media type. Enforced on write so the
 * catalog can never hold an image model claiming `text2video` — the CLI resolves
 * models by (mediaType, capability) and a nonsense pair would make a model
 * unreachable in a way that looks like a CLI bug.
 */
const CAPABILITIES_BY_TYPE: Record<MediaType, readonly MediaCapability[]> = {
  image: ['generate', 'edit'],
  video: ['text2video', 'image2video'],
}

/**
 * Backends that actually serve each media type. Enforced on write for the same
 * reason as capabilities: the CLI has one HTTP client per (mediaType, backend)
 * pair, so an image model on `nvcf` or `fal` names a client that does not exist
 * and the model would be unusable.
 */
const BACKENDS_BY_TYPE: Record<MediaType, readonly MediaBackend[]> = {
  image: ['nvidia', 'vertex'],
  video: ['nvcf', 'nvidia-svd', 'fal', 'vertex'],
}

@Injectable()
export class MediaModelsService {
  private readonly logger = new Logger(MediaModelsService.name)

  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<MediaModel[]> {
    return this.prisma.mediaModel.findMany({
      orderBy: [{ mediaType: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
    })
  }

  /** Everything ENABLED, optionally narrowed to one media type. */
  findEnabled(mediaType?: MediaType): Promise<MediaModel[]> {
    return this.prisma.mediaModel.findMany({
      where: { enabled: true, ...(mediaType ? { mediaType } : {}) },
      orderBy: [{ mediaType: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
    })
  }

  findByCode(code: string): Promise<MediaModel | null> {
    return this.prisma.mediaModel.findUnique({ where: { code } })
  }

  /**
   * Enabled media models a plan may use. An EMPTY allowedPlanCodes means "every
   * plan" — media generation is gated by the image_generation/video_generation
   * feature flags, so an unrestricted model is the normal case and must not be
   * read as "nobody".
   */
  async findAllowedForPlan(
    planCode: string,
    mediaType?: MediaType,
  ): Promise<MediaModel[]> {
    const all = await this.findEnabled(mediaType)
    return all.filter((m) => {
      const codes = mediaAllowedPlanCodes(m)
      return codes.length === 0 || codes.includes(planCode)
    })
  }

  async create(data: CreateMediaModel): Promise<MediaModel> {
    const mediaType = this.requireMediaType(data.mediaType)
    const capabilities = this.requireCapabilities(mediaType, data.capabilities)
    return this.prisma.mediaModel.create({
      data: {
        code: data.code,
        label: data.label ?? data.code,
        mediaType,
        capabilities: capabilities as Prisma.InputJsonValue,
        backend: this.requireBackend(data.backend, mediaType),
        family: this.requireFamily(data.family),
        nvcfFunctionId: data.nvcfFunctionId ?? null,
        estimatedSeconds: data.estimatedSeconds ?? null,
        defaultParams: (data.defaultParams ?? undefined) as
          | Prisma.InputJsonValue
          | undefined,
        allowedPlanCodes: (data.allowedPlanCodes ?? []) as Prisma.InputJsonValue,
        isDefault: data.isDefault ?? false,
        sortOrder: data.sortOrder ?? 0,
        enabled: data.enabled ?? true,
      },
    })
  }

  async update(code: string, patch: MediaModelPatch): Promise<MediaModel> {
    const existing = await this.findByCode(code)
    if (!existing) throw new NotFoundException(`Unknown media model: ${code}`)
    const data: Prisma.MediaModelUpdateInput = {}
    if (patch.label !== undefined) data.label = patch.label
    // mediaType and capabilities are validated TOGETHER: narrowing the type must
    // not leave capabilities that no longer apply to it.
    const effectiveType = patch.mediaType ?? (existing.mediaType as MediaType)
    if (patch.mediaType !== undefined) {
      data.mediaType = this.requireMediaType(patch.mediaType)
    }
    if (patch.capabilities !== undefined || patch.mediaType !== undefined) {
      const caps = patch.capabilities ?? mediaCapabilitiesOf(existing)
      data.capabilities = this.requireCapabilities(
        effectiveType,
        caps,
      ) as Prisma.InputJsonValue
    }
    // The backend is re-validated whenever EITHER side of the pair moves, so
    // narrowing a video model to `image` cannot leave it on an nvcf backend.
    if (patch.backend !== undefined || patch.mediaType !== undefined) {
      data.backend = this.requireBackend(
        patch.backend ?? (existing.backend as MediaBackend),
        effectiveType,
      )
    }
    if (patch.family !== undefined) data.family = this.requireFamily(patch.family)
    if (patch.nvcfFunctionId !== undefined)
      data.nvcfFunctionId = patch.nvcfFunctionId
    if (patch.estimatedSeconds !== undefined)
      data.estimatedSeconds = patch.estimatedSeconds
    if (patch.defaultParams !== undefined) {
      data.defaultParams =
        patch.defaultParams === null
          ? Prisma.DbNull
          : (patch.defaultParams as Prisma.InputJsonValue)
    }
    if (patch.allowedPlanCodes !== undefined)
      data.allowedPlanCodes = patch.allowedPlanCodes as Prisma.InputJsonValue
    if (patch.isDefault !== undefined) data.isDefault = patch.isDefault
    if (patch.sortOrder !== undefined) data.sortOrder = patch.sortOrder
    if (patch.enabled !== undefined) data.enabled = patch.enabled
    return this.prisma.mediaModel.update({ where: { code }, data })
  }

  async remove(code: string): Promise<{ deleted: true }> {
    const existing = await this.findByCode(code)
    if (!existing) throw new NotFoundException(`Unknown media model: ${code}`)
    await this.prisma.mediaModel.delete({ where: { code } })
    return { deleted: true }
  }

  /**
   * Create-if-missing seed of the shipped defaults.
   *
   * Unlike the hosted CHAT catalog (which is gated behind SEED_CATALOG because it
   * carries provider routing an operator must own), the media catalog is pure
   * metadata about public third-party endpoints the user's OWN key calls. So the
   * caller seeds it when the table is EMPTY — a fresh deployment gets working
   * image/video generation — while an admin who disabled or deleted a model keeps
   * that decision, because a non-empty table is never re-seeded unless
   * SEED_CATALOG=true is set explicitly.
   *
   * Existing rows are never modified: every field is admin-owned.
   */
  async seedDefaults(): Promise<void> {
    for (const m of MEDIA_MODEL_SEED) {
      const existing = await this.findByCode(m.code)
      if (existing) continue
      await this.prisma.mediaModel.create({
        data: {
          code: m.code,
          label: m.label,
          mediaType: m.mediaType,
          capabilities: m.capabilities as Prisma.InputJsonValue,
          backend: m.backend,
          family: m.family,
          nvcfFunctionId: m.nvcfFunctionId ?? null,
          estimatedSeconds: m.estimatedSeconds ?? null,
          defaultParams: (m.defaultParams ?? undefined) as
            | Prisma.InputJsonValue
            | undefined,
          allowedPlanCodes: (m.allowedPlanCodes ?? []) as Prisma.InputJsonValue,
          isDefault: m.isDefault ?? false,
          sortOrder: m.sortOrder,
          enabled: m.enabled,
        },
      })
    }
  }

  /** How many rows exist (used to decide first-boot seeding). */
  count(): Promise<number> {
    return this.prisma.mediaModel.count()
  }

  /**
   * Seed only when the catalog is empty (or the operator opted in). Called on
   * boot; see seedDefaults for why the media catalog seeds by default while the
   * chat catalog does not.
   */
  async seedIfEmpty(force = false): Promise<void> {
    if (!force && (await this.count()) > 0) return
    await this.seedDefaults()
  }

  /**
   * Boot-time audit: WARN (never mutate) about rows the CLI would not be able to
   * use — an unknown family (no body builder), an NVCF-backed video model with no
   * function id, or a capability that does not apply to its media type. These can
   * only come from a direct database edit, since create/update reject them.
   */
  async auditMediaCatalog(): Promise<void> {
    const all = await this.findAll()
    // Two enabled defaults for the same (mediaType, backend, capability) make the
    // CLI's pick depend on sortOrder, i.e. two users can silently get different
    // models for the same request. Warn rather than mutate: which one wins is the
    // admin's call, made in the dashboard.
    const defaults = new Map<string, string[]>()
    for (const m of all) {
      const caps = mediaCapabilitiesOf(m)
      if (m.enabled && m.isDefault) {
        for (const c of caps) {
          const key = `${m.mediaType}/${m.backend}/${c}`
          defaults.set(key, [...(defaults.get(key) ?? []), m.code])
        }
      }
      if (!(MEDIA_FAMILIES as readonly string[]).includes(m.family)) {
        this.logger.warn(
          `media model "${m.code}" has unknown family "${m.family}" — the CLI has no ` +
            `request builder for it and will refuse to use the model.`,
        )
      }
      if (caps.length === 0) {
        this.logger.warn(
          `media model "${m.code}" declares no usable capabilities — it will never be offered.`,
        )
      }
      const valid = CAPABILITIES_BY_TYPE[m.mediaType as MediaType] ?? []
      for (const c of caps) {
        if (!valid.includes(c)) {
          this.logger.warn(
            `media model "${m.code}" (${m.mediaType}) declares capability "${c}", which ` +
              `only applies to ${c === 'generate' || c === 'edit' ? 'image' : 'video'} models.`,
          )
        }
      }
      const validBackends = BACKENDS_BY_TYPE[m.mediaType as MediaType] ?? []
      if (!validBackends.includes(m.backend as MediaBackend)) {
        this.logger.warn(
          `media model "${m.code}" (${m.mediaType}) uses backend "${m.backend}", which does ` +
            `not serve that media type (allowed: ${validBackends.join(', ')}) — the CLI has no ` +
            `client for that pair and will not use the model.`,
        )
      }
    }
    for (const [key, codes] of defaults) {
      if (codes.length > 1) {
        this.logger.warn(
          `media models ${codes.map((c) => `"${c}"`).join(', ')} are ALL marked default for ` +
            `${key} — the CLI will pick the lowest sortOrder. Leave exactly one default.`,
        )
      }
    }
  }

  private requireMediaType(v: MediaType | undefined): MediaType {
    if (!v || !(MEDIA_TYPES as readonly string[]).includes(v)) {
      throw new BadRequestException(
        `mediaType is required and must be one of: ${MEDIA_TYPES.join(', ')}`,
      )
    }
    return v
  }

  private requireBackend(
    v: MediaBackend | undefined,
    mediaType: MediaType,
  ): MediaBackend {
    if (!v || !(MEDIA_BACKENDS as readonly string[]).includes(v)) {
      throw new BadRequestException(
        `backend is required and must be one of: ${MEDIA_BACKENDS.join(', ')}`,
      )
    }
    const valid = BACKENDS_BY_TYPE[mediaType]
    if (!valid.includes(v)) {
      throw new BadRequestException(
        `backend "${v}" does not serve ${mediaType} models (allowed: ${valid.join(', ')}). ` +
          `The CLI has no client for that pair, so the model would be unusable.`,
      )
    }
    return v
  }

  private requireFamily(v: MediaFamily | undefined): MediaFamily {
    if (!v || !(MEDIA_FAMILIES as readonly string[]).includes(v)) {
      throw new BadRequestException(
        `family is required and must be one of: ${MEDIA_FAMILIES.join(', ')}. ` +
          `A family the CLI does not know has no request builder, so the model would be unusable.`,
      )
    }
    return v
  }

  private requireCapabilities(
    mediaType: MediaType,
    caps: MediaCapability[] | undefined,
  ): MediaCapability[] {
    const valid = CAPABILITIES_BY_TYPE[mediaType]
    if (!caps || caps.length === 0) {
      throw new BadRequestException(
        `capabilities is required for a ${mediaType} model: pick from ${valid.join(', ')}`,
      )
    }
    for (const c of caps) {
      if (!valid.includes(c)) {
        throw new BadRequestException(
          `capability "${c}" is not valid for a ${mediaType} model (allowed: ${valid.join(', ')})`,
        )
      }
    }
    // De-duplicate so ["generate","generate"] can't skew a capability count.
    return [...new Set(caps)]
  }
}
