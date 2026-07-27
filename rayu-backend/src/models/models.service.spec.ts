import { MODEL_SEED } from './models.constants'
import type { PrismaService } from '../prisma/prisma.service'

// The gateway routes hosted models off the model's PROVIDER row (wire format,
// base URL, auth scheme, key env) plus its upstreamModelId. When MODEL_SEED
// re-points a model at a different provider, seedDefaults must repoint the
// EXISTING row on boot — otherwise the create-if-missing seed leaves old rows
// hitting the old provider. These tests lock that in, plus the provider-id
// validation and the provider kill switch.
function seedFor(code: string) {
  const m = MODEL_SEED.find((x) => x.code === code)
  if (!m) throw new Error(`seed missing ${code}`)
  return m
}

// Provider registry rows the fake Prisma resolves by name/id.
const PROVIDERS = [
  { id: 1, name: 'deepseek', supportsReasoning: true, supportsImage: false, enabled: true },
  { id: 2, name: 'longcat', supportsReasoning: true, supportsImage: false, enabled: true },
  { id: 3, name: 'rayu-ollama', supportsReasoning: true, supportsImage: true, enabled: true },
]

function makeService(
  existingByCode: Record<string, unknown>,
  opts: { providers?: typeof PROVIDERS } = {},
) {
  const providers = opts.providers ?? PROVIDERS
  // Arg types are declared so mock.calls is typed (ts-jest infers [] otherwise).
  const update = jest.fn(
    (_args: { where: { code: string }; data: Record<string, unknown> }) =>
      Promise.resolve({}),
  )
  const create = jest.fn((_args: { data: Record<string, unknown> }) =>
    Promise.resolve({}),
  )
  const findMany = jest.fn((_args?: Record<string, unknown>) =>
    Promise.resolve(Object.values(existingByCode)),
  )
  const prisma = {
    hostedModel: {
      findUnique: jest.fn((args: { where: { code: string } }) =>
        Promise.resolve(existingByCode[args.where.code] ?? null),
      ),
      findMany,
      update,
      create,
    },
    provider: {
      findUnique: jest.fn((args: { where: { name?: string; id?: number } }) =>
        Promise.resolve(
          providers.find(
            (p) =>
              (args.where.name !== undefined && p.name === args.where.name) ||
              (args.where.id !== undefined && p.id === args.where.id),
          ) ?? null,
        ),
      ),
    },
  }
  return {
    service: new ModelsService(prisma as unknown as PrismaService),
    update,
    create,
    findMany,
  }
}

const providerIdOf = (name: string) => PROVIDERS.find((p) => p.name === name)!.id

describe('ModelsService.seedDefaults — routing reconciliation', () => {
  test('repoints existing rows whose provider changed in the seed (Ollama → DeepSeek)', async () => {
    const pro = seedFor('deepseek-v4-pro')
    const flash = seedFor('deepseek-v4-flash')
    // Sanity: the seed routes these DIRECT to DeepSeek's own provider row, using
    // DeepSeek's own model ids — NOT Ollama Cloud `:cloud` tags.
    for (const m of [pro, flash]) {
      expect(m.providerName).toBe('deepseek')
    }
    expect(pro.upstreamModelId).toBe('deepseek-v4-pro')
    expect(flash.upstreamModelId).toBe('deepseek-v4-flash')

    // Existing DB rows are still on the OLD Ollama Cloud provider.
    const stale = (code: string) => ({
      code,
      providerId: providerIdOf('rayu-ollama'),
      upstreamModelId: `${code}:cloud`,
    })
    const { service, update } = makeService({
      'deepseek-v4-pro': stale('deepseek-v4-pro'),
      'deepseek-v4-flash': stale('deepseek-v4-flash'),
    })

    await service.seedDefaults()

    for (const m of [pro, flash]) {
      expect(update).toHaveBeenCalledWith({
        where: { code: m.code },
        data: {
          providerId: providerIdOf('deepseek'),
          upstreamModelId: m.upstreamModelId,
        },
      })
    }
  })

  test('leaves an existing row untouched when its provider already matches the seed (preserves admin-tuned upstream id)', async () => {
    const glm = seedFor('glm-5.2') // already on the Ollama Cloud provider
    expect(glm.providerName).toBe('rayu-ollama')
    const { service, update } = makeService({
      'glm-5.2': {
        code: 'glm-5.2',
        providerId: providerIdOf('rayu-ollama'),
        upstreamModelId: 'admin-tuned-tag', // must NOT be clobbered
      },
    })

    await service.seedDefaults()

    expect(
      update.mock.calls.find((c) => c[0].where.code === 'glm-5.2'),
    ).toBeUndefined()
  })

  test('creates models that do not exist yet; no updates when nothing pre-exists', async () => {
    const { service, create, update } = makeService({})
    await service.seedDefaults()
    expect(create).toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  test('seeds capability flags from the seed entry', async () => {
    const { service, create } = makeService({})
    await service.seedDefaults()
    const llama = create.mock.calls
      .map((c) => c[0].data)
      .find((d) => d.code === 'llama-4')
    expect(llama).toMatchObject({ supportsImage: true, supportsReasoning: false })
  })

  // The context window is what the CLI budgets against (auto-compaction, context
  // warnings), so every seeded model must ship a real one rather than leaving the
  // client on its generic default.
  test('seeds a context window for every seeded model', async () => {
    const { service, create } = makeService({})
    await service.seedDefaults()
    const seeded = create.mock.calls.map((c) => c[0].data)
    expect(seeded.length).toBeGreaterThan(0)
    for (const m of seeded) {
      expect(typeof m.contextWindow).toBe('number')
      expect(m.contextWindow as number).toBeGreaterThanOrEqual(128_000)
    }
    expect(seeded.find((d) => d.code === 'deepseek-v4-pro')?.contextWindow).toBe(1_000_000)
    expect(seeded.find((d) => d.code === 'gpt-oss-120b')?.contextWindow).toBe(128_000)
  })

  test('skips (does not crash) when a seed names a provider missing from the registry', async () => {
    // Admin renamed/deleted the Ollama provider: its models must not fail boot.
    const { service, create } = makeService({}, {
      providers: PROVIDERS.filter((p) => p.name !== 'rayu-ollama'),
    })
    await service.seedDefaults()
    const created = create.mock.calls.map((c) => c[0].data.code)
    expect(created).toContain('deepseek-v4-pro')
    expect(created).not.toContain('glm-5.2')
  })
})

import { Logger } from '@nestjs/common'
import { isModelFamilyConsistent, ModelsService } from './models.service'

describe('isModelFamilyConsistent', () => {
  test('rejects a definite cross-family mapping, allows same-family + opaque', () => {
    expect(
      isModelFamilyConsistent('claude-sonnet-4-6', 'us.anthropic.claude-opus-4-6-v1'),
    ).toBe(false)
    expect(
      isModelFamilyConsistent('claude-sonnet-4-6', 'us.anthropic.claude-sonnet-4-6-v1:0'),
    ).toBe(true)
    // Non-Claude codes/upstreams carry no family constraint.
    expect(isModelFamilyConsistent('deepseek-v4-pro', 'deepseek-v4-pro')).toBe(true)
    expect(isModelFamilyConsistent('glm-5.2', 'glm-5.2:cloud')).toBe(true)
  })
})

describe('ModelsService — provider binding', () => {
  test('create() requires a providerId (no silent default upstream)', async () => {
    const { service, create } = makeService({})
    await expect(
      service.create({ code: 'new-model', upstreamModelId: 'new-model' }),
    ).rejects.toThrow(/providerId is required/i)
    expect(create).not.toHaveBeenCalled()
  })

  test('create() rejects an unknown providerId', async () => {
    const { service, create } = makeService({})
    await expect(
      service.create({ code: 'new-model', providerId: 999 }),
    ).rejects.toThrow(/Unknown providerId 999/i)
    expect(create).not.toHaveBeenCalled()
  })

  // The four charges are admin-owned and used verbatim by the gateway, so a
  // partially-filled form must produce sane, explicit numbers — never a 0 charge
  // (bills nothing) and never a null the gateway has to guess about.
  test('create() fills the four credit charges explicitly', async () => {
    const { service, create } = makeService({})
    await service.create({
      code: 'm',
      providerId: providerIdOf('deepseek'),
      creditMultiplier: 2,
    })
    expect(create.mock.calls[0][0].data).toMatchObject({
      creditMultiplier: 2, // input, as entered
      outputCreditMultiplier: 2, // defaults to input
      cacheReadCreditMultiplier: 0.1, // the 10% cache weight
      cacheWriteCreditMultiplier: 2, // defaults to input
    })
  })

  test('create() honours every explicitly entered charge, including a cheap output', async () => {
    const { service, create } = makeService({})
    await service.create({
      code: 'm',
      providerId: providerIdOf('deepseek'),
      creditMultiplier: 2,
      outputCreditMultiplier: 0.5,
      cacheReadCreditMultiplier: 0,
      cacheWriteCreditMultiplier: 3,
    })
    expect(create.mock.calls[0][0].data).toMatchObject({
      creditMultiplier: 2,
      outputCreditMultiplier: 0.5,
      cacheReadCreditMultiplier: 0, // free cache reads are legitimate
      cacheWriteCreditMultiplier: 3,
    })
  })

  test('update() patches each charge independently', async () => {
    const { service, update } = makeService({
      'glm-5.2': { code: 'glm-5.2', providerId: 3, upstreamModelId: 'glm-5.2:cloud' },
    })
    await service.update('glm-5.2', { outputCreditMultiplier: 4, supportsTools: false })
    expect(update.mock.calls[0][0].data).toMatchObject({
      outputCreditMultiplier: 4,
      supportsTools: false,
    })
    expect(update.mock.calls[0][0].data).not.toHaveProperty('creditMultiplier')
  })

  test('create() inherits capability defaults from the provider', async () => {    const { service, create } = makeService({})
    await service.create({ code: 'new-model', providerId: providerIdOf('rayu-ollama') })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          providerId: providerIdOf('rayu-ollama'),
          supportsReasoning: true,
          supportsImage: true, // from the provider row
        }),
      }),
    )
  })

  test('create() lets an explicit flag override the provider default', async () => {
    const { service, create } = makeService({})
    await service.create({
      code: 'new-model',
      providerId: providerIdOf('rayu-ollama'),
      supportsImage: false,
    })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ supportsImage: false }),
      }),
    )
  })

  // An explicit null must CLEAR the window (back to "CLI default"), which is
  // different from omitting the field (leave as-is).
  test('update() distinguishes clearing the context window from leaving it alone', async () => {
    const existing = {
      'glm-5.2': { code: 'glm-5.2', providerId: 3, upstreamModelId: 'glm-5.2:cloud' },
    }
    const cleared = makeService(existing)
    await cleared.service.update('glm-5.2', { contextWindow: null })
    expect(cleared.update.mock.calls[0][0].data).toMatchObject({ contextWindow: null })

    const set = makeService(existing)
    await set.service.update('glm-5.2', { contextWindow: 1_000_000 })
    expect(set.update.mock.calls[0][0].data).toMatchObject({ contextWindow: 1_000_000 })

    const untouched = makeService(existing)
    await untouched.service.update('glm-5.2', { label: 'GLM' })
    expect(untouched.update.mock.calls[0][0].data).not.toHaveProperty('contextWindow')
  })

  test('update() rejects an unknown providerId', async () => {    const { service, update } = makeService({
      'glm-5.2': { code: 'glm-5.2', providerId: 3, upstreamModelId: 'glm-5.2:cloud' },
    })
    await expect(service.update('glm-5.2', { providerId: 999 })).rejects.toThrow(
      /Unknown providerId/i,
    )
    expect(update).not.toHaveBeenCalled()
  })

  test('findEnabled() excludes models of a DISABLED provider at the query level', async () => {
    const { service, findMany } = makeService({})
    await service.findEnabled()
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { enabled: true, provider: { enabled: true } },
      }),
    )
  })

  test('findAll() (admin catalog) does NOT filter by provider.enabled', async () => {
    const { service, findMany } = makeService({})
    await service.findAll()
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { id: 'asc' } }),
    )
    expect(findMany.mock.calls[0]?.[0]).not.toHaveProperty('where')
  })
})

describe('ModelsService — catalog family-consistency guard', () => {
  const pid = providerIdOf('deepseek')

  test('create() rejects a Sonnet code mapped to an Opus upstream', async () => {
    const { service, create } = makeService({})
    await expect(
      service.create({
        code: 'claude-sonnet-4-6',
        providerId: pid,
        upstreamModelId: 'us.anthropic.claude-opus-4-6-v1',
      }),
    ).rejects.toThrow(/different model family/i)
    expect(create).not.toHaveBeenCalled()
  })

  test('create() allows a same-family Sonnet mapping', async () => {
    const { service, create } = makeService({})
    await service.create({
      code: 'claude-sonnet-4-6',
      providerId: pid,
      upstreamModelId: 'us.anthropic.claude-sonnet-4-6-v1:0',
    })
    expect(create).toHaveBeenCalled()
  })

  test('create() allows non-Claude (opaque) mappings unchanged', async () => {
    const { service, create } = makeService({})
    await service.create({
      code: 'deepseek-v4-pro',
      providerId: pid,
      upstreamModelId: 'deepseek-v4-pro',
    })
    expect(create).toHaveBeenCalled()
  })

  test('update() rejects repointing a Sonnet code at an Opus upstream', async () => {
    const { service, update } = makeService({
      'claude-sonnet-4-6': {
        code: 'claude-sonnet-4-6',
        providerId: pid,
        upstreamModelId: 'us.anthropic.claude-sonnet-4-6-v1:0',
      },
    })
    await expect(
      service.update('claude-sonnet-4-6', {
        upstreamModelId: 'us.anthropic.claude-opus-4-6-v1',
      }),
    ).rejects.toThrow(/different model family/i)
    expect(update).not.toHaveBeenCalled()
  })

  test('boot audit WARNS (does not throw/mutate) on an existing mismatched row', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    try {
      const { service, update } = makeService({
        'claude-sonnet-4-6': {
          code: 'claude-sonnet-4-6',
          providerId: pid,
          upstreamModelId: 'us.anthropic.claude-opus-4-6-v1', // cross-family (bad)
        },
      })
      await service.auditModelFamilyConsistency()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(update).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
