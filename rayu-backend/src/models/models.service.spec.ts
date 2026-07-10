import { ModelsService } from './models.service'
import { MODEL_SEED } from './models.constants'
import type { PrismaService } from '../prisma/prisma.service'

// The gateway routes hosted models purely off hosted_models.provider /
// upstreamBaseUrl / upstreamModelId. When MODEL_SEED re-points a model at a new
// upstream provider (e.g. DeepSeek V4 → Ollama Cloud), seedDefaults must
// repoint the EXISTING row's routing on boot — otherwise the create-if-missing
// seed leaves old rows hitting the old provider. These tests lock that in.
function seedFor(code: string) {
  const m = MODEL_SEED.find((x) => x.code === code)
  if (!m) throw new Error(`seed missing ${code}`)
  return m
}

function makeService(existingByCode: Record<string, unknown>) {
  const update = jest.fn(() => Promise.resolve({}))
  const create = jest.fn(() => Promise.resolve({}))
  const prisma = {
    hostedModel: {
      findUnique: jest.fn((args: { where: { code: string } }) =>
        Promise.resolve(existingByCode[args.where.code] ?? null),
      ),
      update,
      create,
    },
  }
  return {
    service: new ModelsService(prisma as unknown as PrismaService),
    update,
    create,
  }
}

describe('ModelsService.seedDefaults — routing reconciliation', () => {
  test('repoints existing rows whose provider changed in the seed (DeepSeek → Ollama)', async () => {
    const pro = seedFor('deepseek-v4-pro')
    const flash = seedFor('deepseek-v4-flash')
    // Sanity: the seed itself moved these OFF the official deepseek provider,
    // onto the exact Ollama Cloud tags.
    for (const m of [pro, flash]) {
      expect(m.provider).not.toBe('deepseek')
      expect(m.upstreamBaseUrl).toBe('https://ollama.com')
    }
    expect(pro.upstreamModelId).toBe('deepseek-v4-pro:cloud')
    expect(flash.upstreamModelId).toBe('deepseek-v4-flash:cloud')

    // Existing DB rows are still on the OLD official 'deepseek' upstream.
    const stale = (code: string) => ({
      code,
      provider: 'deepseek',
      upstreamBaseUrl: 'https://api.deepseek.com',
      upstreamModelId: 'deepseek-chat',
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
          provider: m.provider,
          upstreamBaseUrl: m.upstreamBaseUrl,
          upstreamModelId: m.upstreamModelId,
        },
      })
    }
  })

  test('leaves an existing row untouched when its provider already matches the seed (preserves admin-tuned upstream id)', async () => {
    const glm = seedFor('glm-5.2') // provider already = the Ollama provider
    const { service, update } = makeService({
      'glm-5.2': {
        code: 'glm-5.2',
        provider: glm.provider,
        upstreamBaseUrl: 'https://ollama.com',
        upstreamModelId: 'admin-tuned-tag', // must NOT be clobbered
      },
    })

    await service.seedDefaults()

    const calls = update.mock.calls as unknown as Array<[{ where: { code: string } }]>
    const glmUpdate = calls.find((c) => c[0]?.where?.code === 'glm-5.2')
    expect(glmUpdate).toBeUndefined()
  })

  test('creates models that do not exist yet; no updates when nothing pre-exists', async () => {
    const { service, create, update } = makeService({})
    await service.seedDefaults()
    expect(create).toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })
})
