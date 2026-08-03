import type { MediaModel } from '@prisma/client'
import type { PrismaService } from '../prisma/prisma.service'
import { MEDIA_MODEL_SEED } from './media-models.constants'
import {
  MediaModelsService,
  mediaAllowedPlanCodes,
  mediaCapabilitiesOf,
} from './media-models.service'

// The media catalog is the CLI's ONLY source of image/video models, so the
// invariants here are load-bearing: a row the CLI cannot use (unknown family,
// nonsense capability) makes a model silently unavailable, and the empty-plan-list
// rule decides whether the whole catalog is visible or hidden.

function row(over: Partial<MediaModel> = {}): MediaModel {
  return {
    id: 1,
    code: 'black-forest-labs/flux.1-schnell',
    label: 'FLUX.1 Schnell',
    mediaType: 'image',
    capabilities: ['generate'],
    backend: 'nvidia',
    family: 'flux',
    nvcfFunctionId: null,
    estimatedSeconds: null,
    defaultParams: { cfg_scale: 0, steps: 4 },
    allowedPlanCodes: [],
    isDefault: true,
    sortOrder: 10,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as MediaModel
}

function makeService(existing: MediaModel[] = []) {
  const byCode = new Map(existing.map((m) => [m.code, m]))
  const create = jest.fn((_args: { data: Record<string, unknown> }) =>
    Promise.resolve({}),
  )
  const update = jest.fn(
    (_args: { where: { code: string }; data: Record<string, unknown> }) =>
      Promise.resolve({}),
  )
  const prisma = {
    mediaModel: {
      findUnique: jest.fn((args: { where: { code: string } }) =>
        Promise.resolve(byCode.get(args.where.code) ?? null),
      ),
      findMany: jest.fn((args?: { where?: { enabled?: boolean; mediaType?: string } }) =>
        Promise.resolve(
          existing.filter(
            (m) =>
              (args?.where?.enabled === undefined || m.enabled === args.where.enabled) &&
              (args?.where?.mediaType === undefined ||
                m.mediaType === args.where.mediaType),
          ),
        ),
      ),
      count: jest.fn(() => Promise.resolve(existing.length)),
      create,
      update,
      delete: jest.fn(() => Promise.resolve({})),
    },
  }
  return {
    service: new MediaModelsService(prisma as unknown as PrismaService),
    create,
    update,
  }
}

describe('MediaModelsService — write validation', () => {
  it('rejects a capability that does not apply to the media type', async () => {
    const { service } = makeService()
    await expect(
      service.create({
        code: 'x/y',
        mediaType: 'image',
        // text2video is a VIDEO capability — an image model claiming it would be
        // unreachable, since the CLI resolves by (mediaType, capability).
        capabilities: ['text2video'],
        backend: 'nvidia',
        family: 'flux',
      }),
    ).rejects.toThrow(/not valid for a image model/)
  })

  it('rejects a family the CLI has no request builder for', async () => {
    const { service } = makeService()
    await expect(
      service.create({
        code: 'x/y',
        mediaType: 'image',
        capabilities: ['generate'],
        backend: 'nvidia',
        family: 'holodeck' as never,
      }),
    ).rejects.toThrow(/family is required and must be one of/)
  })

  it('rejects an unknown backend', async () => {
    const { service } = makeService()
    await expect(
      service.create({
        code: 'x/y',
        mediaType: 'image',
        capabilities: ['generate'],
        backend: 'mystery' as never,
        family: 'flux',
      }),
    ).rejects.toThrow(/backend is required and must be one of/)
  })

  it('rejects a backend that does not serve the media type', async () => {
    // The CLI has one HTTP client per (mediaType, backend) pair, so an image model
    // on `nvcf` names a client that does not exist.
    const { service } = makeService()
    await expect(
      service.create({
        code: 'x/y',
        mediaType: 'image',
        capabilities: ['generate'],
        backend: 'nvcf',
        family: 'flux',
      }),
    ).rejects.toThrow(/does not serve image models/)
  })

  it('re-validates the backend when the media type is narrowed', async () => {
    const { service } = makeService([
      row({
        code: 'v/1',
        mediaType: 'video',
        capabilities: ['text2video'],
        backend: 'nvcf',
        family: 'cosmos-predict1',
      }),
    ])
    // Changing only mediaType must not leave the row on a video-only backend.
    await expect(
      service.update('v/1', { mediaType: 'image', capabilities: ['generate'] }),
    ).rejects.toThrow(/does not serve image models/)
  })

  it('requires at least one capability', async () => {
    const { service } = makeService()
    await expect(
      service.create({
        code: 'x/y',
        mediaType: 'video',
        capabilities: [],
        backend: 'nvcf',
        family: 'cosmos-predict1',
      }),
    ).rejects.toThrow(/capabilities is required/)
  })

  it('de-duplicates capabilities on write', async () => {
    const { service, create } = makeService()
    await service.create({
      code: 'x/y',
      mediaType: 'video',
      capabilities: ['text2video', 'text2video'],
      backend: 'nvcf',
      family: 'cosmos-predict1',
    })
    expect(create.mock.calls[0][0].data.capabilities).toEqual(['text2video'])
  })

  it('re-validates capabilities when the media type is narrowed', async () => {
    const { service } = makeService([
      row({ code: 'v/1', mediaType: 'video', capabilities: ['text2video'], family: 'veo' }),
    ])
    await expect(
      service.update('v/1', { mediaType: 'image' }),
    ).rejects.toThrow(/not valid for a image model/)
  })
})

describe('MediaModelsService — plan filtering', () => {
  it('treats an EMPTY allowedPlanCodes as every plan', async () => {
    const { service } = makeService([
      row({ code: 'open', allowedPlanCodes: [] }),
      row({ id: 2, code: 'max-only', allowedPlanCodes: ['max'] }),
    ])
    const free = await service.findAllowedForPlan('free')
    expect(free.map((m) => m.code)).toEqual(['open'])
    const max = await service.findAllowedForPlan('max')
    expect(max.map((m) => m.code)).toEqual(['open', 'max-only'])
  })

  it('excludes disabled rows', async () => {
    const { service } = makeService([
      row({ code: 'on', enabled: true }),
      row({ id: 2, code: 'off', enabled: false }),
    ])
    const models = await service.findAllowedForPlan('pro')
    expect(models.map((m) => m.code)).toEqual(['on'])
  })
})

describe('MediaModelsService — seeding', () => {
  it('seeds the shipped defaults when the table is empty', async () => {
    const { service, create } = makeService([])
    await service.seedIfEmpty()
    expect(create).toHaveBeenCalledTimes(MEDIA_MODEL_SEED.length)
  })

  it('leaves a non-empty catalog alone (a removed model stays removed)', async () => {
    const { service, create } = makeService([row()])
    await service.seedIfEmpty()
    expect(create).not.toHaveBeenCalled()
  })

  it('never overwrites an existing row when forced to re-seed', async () => {
    // The admin renamed/retuned flux.1-schnell; a forced seed must not undo it.
    const { service, create, update } = makeService([
      row({ label: 'My custom label', enabled: false }),
    ])
    await service.seedIfEmpty(true)
    expect(update).not.toHaveBeenCalled()
    const createdCodes = create.mock.calls.map((c) => c[0].data.code)
    expect(createdCodes).not.toContain('black-forest-labs/flux.1-schnell')
    expect(createdCodes).toHaveLength(MEDIA_MODEL_SEED.length - 1)
  })
})

describe('MediaModelsService — boot audit (warn only, never mutate)', () => {
  function captureWarnings(service: MediaModelsService): string[] {
    const warnings: string[] = []
    // The audit's whole job is telling an operator about a row the CLI cannot
    // use, so the message text is the behaviour under test.
    ;(service as unknown as { logger: { warn: (m: string) => void } }).logger = {
      warn: (m: string) => warnings.push(m),
    }
    return warnings
  }

  it('warns when two enabled models are both default for the same triple', async () => {
    const { service, update } = makeService([
      row({ id: 1, code: 'a/1', isDefault: true }),
      row({ id: 2, code: 'a/2', isDefault: true }),
    ])
    const warnings = captureWarnings(service)
    await service.auditMediaCatalog()
    expect(warnings.join('\n')).toMatch(/"a\/1", "a\/2" are ALL marked default/)
    // Which one wins is the admin's call — the audit must not pick for them.
    expect(update).not.toHaveBeenCalled()
  })

  it('does not warn when a DISABLED row shares the default flag', async () => {
    const { service } = makeService([
      row({ id: 1, code: 'a/1', isDefault: true }),
      row({ id: 2, code: 'a/2', isDefault: true, enabled: false }),
    ])
    const warnings = captureWarnings(service)
    await service.auditMediaCatalog()
    expect(warnings.join('\n')).not.toMatch(/ALL marked default/)
  })

  it('warns about an unknown family the CLI cannot build', async () => {
    const { service } = makeService([row({ family: 'holodeck' })])
    const warnings = captureWarnings(service)
    await service.auditMediaCatalog()
    expect(warnings.join('\n')).toMatch(/unknown family "holodeck"/)
  })

  it('warns about a backend that does not serve the media type', async () => {
    // Only reachable by a direct database edit — create/update reject it.
    const { service } = makeService([row({ mediaType: 'image', backend: 'nvcf' })])
    const warnings = captureWarnings(service)
    await service.auditMediaCatalog()
    expect(warnings.join('\n')).toMatch(/uses backend "nvcf", which does not serve/)
  })

  it('stays silent on the shipped seed', async () => {
    const { service } = makeService(
      MEDIA_MODEL_SEED.map((m, i) =>
        row({
          id: i + 1,
          code: m.code,
          mediaType: m.mediaType,
          capabilities: m.capabilities,
          backend: m.backend,
          family: m.family,
          isDefault: m.isDefault ?? false,
          enabled: m.enabled,
        }),
      ),
    )
    const warnings = captureWarnings(service)
    await service.auditMediaCatalog()
    expect(warnings).toEqual([])
  })
})

describe('MEDIA_MODEL_SEED integrity', () => {
  it('has no duplicate codes', () => {
    const codes = MEDIA_MODEL_SEED.map((m) => m.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('gives every (mediaType, backend, capability) triple exactly one default', () => {
    // Two defaults for the same triple would make the CLI's pick order-dependent.
    const counts = new Map<string, number>()
    for (const m of MEDIA_MODEL_SEED) {
      if (!m.isDefault) continue
      for (const c of m.capabilities) {
        const key = `${m.mediaType}|${m.backend}|${c}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
    for (const [key, n] of counts) {
      expect({ key, n }).toEqual({ key, n: 1 })
    }
  })

  it('gives every NVCF video model a function id, except the legacy cosmos host', () => {
    for (const m of MEDIA_MODEL_SEED) {
      if (m.backend !== 'nvcf') continue
      if (m.family === 'cosmos-legacy') {
        expect(m.nvcfFunctionId).toBeUndefined()
      } else {
        expect(m.nvcfFunctionId).toBeTruthy()
      }
    }
  })
})

describe('JSON column parsers', () => {
  it('drops unknown capabilities rather than passing them to the client', () => {
    expect(
      mediaCapabilitiesOf(row({ capabilities: ['generate', 'teleport'] as never })),
    ).toEqual(['generate'])
  })

  it('reads a missing allowedPlanCodes as an empty list', () => {
    expect(mediaAllowedPlanCodes(row({ allowedPlanCodes: null }))).toEqual([])
  })
})
