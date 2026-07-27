import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'
import type { Provider } from '@prisma/client'
import type { PrismaService } from '../prisma/prisma.service'
import { FORMAT_DEFAULTS } from './providers.constants'
import { ProvidersService } from './providers.service'

// The provider registry is the single source of truth for gateway routing, and
// baseUrl is acted on by the gateway WITH a provider key in hand (outbound
// request). These tests lock down the format defaults plus the security rules
// that stop an admin-supplied value from becoming an SSRF primitive.

type ProviderRow = Partial<Provider> & { name: string }

function makeService(existing: ProviderRow[] = [], modelCount = 0) {
  const rows = new Map(existing.map((p) => [p.name, p]))
  const create = jest.fn((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: rows.size + 1, ...args.data }),
  )
  const update = jest.fn((args: { where: { name: string }; data: Record<string, unknown> }) =>
    Promise.resolve({ ...rows.get(args.where.name), ...args.data }),
  )
  const del = jest.fn(() => Promise.resolve({}))
  const prisma = {
    provider: {
      findUnique: jest.fn((args: { where: { name: string } }) =>
        Promise.resolve(rows.get(args.where.name) ?? null),
      ),
      findMany: jest.fn(() =>
        Promise.resolve([...rows.values()].map((p) => ({ ...p, _count: { models: 0 } }))),
      ),
      create,
      update,
      delete: del,
    },
    hostedModel: { count: jest.fn(() => Promise.resolve(modelCount)) },
  }
  return {
    service: new ProvidersService(prisma as unknown as PrismaService),
    create,
    update,
    del,
  }
}

const VALID = {
  name: 'openrouter',
  format: 'openai_chat' as const,
  baseUrl: 'https://openrouter.ai/api',
}

describe('ProvidersService.create — format defaults', () => {
  test.each([
    ['anthropic_messages', '/anthropic/v1/messages', 'x_api_key'],
    ['openai_chat', '/v1/chat/completions', 'bearer'],
    ['openai_responses', '/v1/responses', 'bearer'],
    ['genai', null, 'x_goog_api_key'],
  ] as const)(
    'applies the %s defaults when endpointPath/authScheme are omitted',
    async (format, endpointPath, authScheme) => {
      const { service, create } = makeService()
      await service.create({ ...VALID, format })
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ format, endpointPath, authScheme }),
        }),
      )
      // FORMAT_DEFAULTS is the single table both this and the gateway follow.
      expect(FORMAT_DEFAULTS[format]).toEqual({ endpointPath, authScheme })
    },
  )

  test('normalizes the name and strips a trailing slash from baseUrl', async () => {
    const { service, create } = makeService()
    await service.create({ ...VALID, name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/' })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'openrouter',
          baseUrl: 'https://openrouter.ai/api',
        }),
      }),
    )
  })

  test('rejects a duplicate name with 409', async () => {
    const { service } = makeService([{ name: 'openrouter' }])
    await expect(service.create(VALID)).rejects.toThrow(ConflictException)
  })

  test('rejects a name that is not a slug', async () => {
    const { service } = makeService()
    await expect(service.create({ ...VALID, name: 'Open Router!' })).rejects.toThrow(
      BadRequestException,
    )
  })

  test('rejects an unknown format', async () => {
    const { service } = makeService()
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      service.create({ ...VALID, format: 'grpc_magic' as any }),
    ).rejects.toThrow(BadRequestException)
  })
})

describe('ProvidersService — baseUrl is not an SSRF primitive', () => {
  // The gateway fetches baseUrl server-side WITH the provider's API key
  // attached, so an admin-supplied value is both an SSRF pivot and a key
  // exfiltration channel. These are refused at the API, and the gateway
  // re-validates the stored row at route time.
  test.each([
    ['http://openrouter.ai/api', 'plaintext: the key would travel unencrypted'],
    ['https://169.254.169.254/latest/meta-data', 'cloud metadata endpoint'],
    ['https://127.0.0.1:8080', 'loopback'],
    ['https://localhost/api', 'loopback by name'],
    ['https://10.0.0.5/api', 'private range'],
    ['https://192.168.1.10/api', 'private range'],
    ['https://172.16.4.4/api', 'private range'],
    ['https://metadata.google.internal/computeMetadata', 'GCP metadata'],
    ['https://[::1]/api', 'IPv6 loopback'],
    ['ftp://openrouter.ai', 'non-http scheme'],
    ['not-a-url', 'unparseable'],
    ['', 'empty'],
  ])('rejects baseUrl %s (%s)', async (baseUrl) => {
    const { service } = makeService()
    await expect(service.create({ ...VALID, baseUrl })).rejects.toThrow(BadRequestException)
  })

  test.each([
    'https://openrouter.ai/api',
    'https://api.deepseek.com',
    'https://generativelanguage.googleapis.com',
  ])('accepts baseUrl %s', async (baseUrl) => {
    const { service, create } = makeService()
    await service.create({ ...VALID, baseUrl })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ baseUrl }) }),
    )
  })
})

describe('ProvidersService — endpointPath stays a path', () => {
  // endpointPath is appended to baseUrl. If it could carry a scheme or traverse
  // upwards it would move the request off the validated origin.
  test.each([
    ['v1/chat/completions', 'must be absolute'],
    ['/../../admin', 'path traversal'],
    ['https://evil.example.com/v1', 'absolute URL escapes the validated origin'],
    ['/v1/chat?key=leak', 'query string'],
    ['/v1/chat#frag', 'fragment'],
  ])('rejects endpointPath %s (%s)', async (endpointPath) => {
    const { service } = makeService()
    await expect(service.create({ ...VALID, endpointPath })).rejects.toThrow(
      BadRequestException,
    )
  })

  test('accepts a plain absolute path', async () => {
    const { service, create } = makeService()
    await service.create({ ...VALID, endpointPath: '/v1/chat/completions' })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ endpointPath: '/v1/chat/completions' }),
      }),
    )
  })
})

describe('ProvidersService.update', () => {
  const existing: ProviderRow = {
    id: 1,
    name: 'openrouter',
    label: 'OpenRouter',
    format: 'openai_chat',
    baseUrl: 'https://openrouter.ai/api',
    endpointPath: '/v1/chat/completions',
    authScheme: 'bearer',
    supportsReasoning: false,
    supportsImage: false,
    enabled: true,
  }

  test('re-derives endpointPath when the format changes without an explicit path', async () => {
    const { service, update } = makeService([existing])
    await service.update('openrouter', { format: 'openai_responses' })
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { name: 'openrouter' },
        data: expect.objectContaining({
          format: 'openai_responses',
          endpointPath: '/v1/responses',
        }),
      }),
    )
  })

  test('keeps the existing path when only unrelated fields change', async () => {
    const { service, update } = makeService([existing])
    await service.update('openrouter', { enabled: false })
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          endpointPath: '/v1/chat/completions',
          enabled: false,
        }),
      }),
    )
  })

  test('cannot loosen security on an existing provider', async () => {
    const { service } = makeService([existing])
    // The gateway fetches baseUrl with a provider key attached, so an edit must
    // not be able to repoint a safely-created provider at link-local metadata.
    await expect(
      service.update('openrouter', { baseUrl: 'https://169.254.169.254' }),
    ).rejects.toThrow(BadRequestException)
    await expect(
      service.update('openrouter', { endpointPath: 'https://evil.example.com/v1' }),
    ).rejects.toThrow(BadRequestException)
  })

  test('unknown provider is a 404', async () => {
    const { service } = makeService()
    await expect(service.update('nope', { enabled: false })).rejects.toThrow(
      NotFoundException,
    )
  })
})

describe('ProvidersService.remove', () => {
  test('refuses to delete a provider that still has models (409)', async () => {
    const { service, del } = makeService([{ name: 'openrouter' }], 3)
    await expect(service.remove('openrouter')).rejects.toThrow(ConflictException)
    expect(del).not.toHaveBeenCalled()
  })

  test('deletes a provider with no models', async () => {
    const { service, del } = makeService([{ name: 'openrouter' }], 0)
    await expect(service.remove('openrouter')).resolves.toEqual({ deleted: true })
    expect(del).toHaveBeenCalledWith({ where: { name: 'openrouter' } })
  })

  test('unknown provider is a 404', async () => {
    const { service } = makeService()
    await expect(service.remove('nope')).rejects.toThrow(NotFoundException)
  })
})

describe('ProvidersService.seedDefaults', () => {
  test('is create-if-missing and never overwrites an existing row', async () => {
    const { service, create, update } = makeService([
      { name: 'deepseek', baseUrl: 'https://admin-edited.example' },
    ])
    await service.seedDefaults()
    expect(update).not.toHaveBeenCalled()
    const seeded = create.mock.calls.map((c) => (c[0].data as { name: string }).name)
    expect(seeded).not.toContain('deepseek')
    expect(seeded).toEqual(expect.arrayContaining(['longcat', 'rayu-ollama']))
  })
})
