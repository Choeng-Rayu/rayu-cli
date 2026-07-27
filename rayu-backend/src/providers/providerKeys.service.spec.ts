import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'
import type { PrismaService } from '../prisma/prisma.service'
import { hashKey, SECRET_ENV } from '../common/secretBox'
import { ProvidersService } from './providers.service'

// Provider API keys are the most sensitive rows in this service. These tests pin
// the security properties of the CRUD layer: the plaintext is never returned,
// duplicates are refused (they silently break rotation), and one provider cannot
// reach another's keys through the id space.

const MASTER = 'spec-master-secret-of-sufficient-length-0123456789'
const PROVIDER = { id: 7, name: 'openrouter' }

type KeyRow = {
  id: number
  providerId: number
  label: string
  encryptedKey: string
  keyHash: string
  maskedKey: string
  priority: number
  enabled: boolean
  status: string
  lastUsedAt: Date | null
  cooldownUntil: Date | null
  lastError: string | null
  createdAt: Date
  updatedAt: Date
}

function keyRow(over: Partial<KeyRow> = {}): KeyRow {
  return {
    id: 1,
    providerId: PROVIDER.id,
    label: 'Key 1',
    encryptedKey: 'v1:sealed',
    keyHash: 'hash-1',
    maskedKey: 'sk-abc••••••••7890(40)',
    priority: 0,
    enabled: true,
    status: 'active',
    lastUsedAt: null,
    cooldownUntil: null,
    lastError: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  }
}

function makeService(keys: KeyRow[] = [], provider: { id: number; name: string } | null = PROVIDER) {
  const rows = [...keys]
  const create = jest.fn((args: { data: Record<string, unknown> }) => {
    const row = keyRow({ id: rows.length + 10, ...(args.data as Partial<KeyRow>) })
    rows.push(row)
    return Promise.resolve(row)
  })
  const update = jest.fn(
    (args: { where: { id: number }; data: Record<string, unknown> }) =>
      Promise.resolve(
        keyRow({ ...rows.find((r) => r.id === args.where.id), ...(args.data as Partial<KeyRow>) }),
      ),
  )
  const del = jest.fn(() => Promise.resolve({}))
  const prisma = {
    provider: {
      findUnique: jest.fn((args: { where: { name?: string } }) =>
        Promise.resolve(provider && provider.name === args.where.name ? provider : null),
      ),
    },
    providerApiKey: {
      findMany: jest.fn(() => Promise.resolve(rows)),
      findUnique: jest.fn(
        (args: {
          where: { id?: number; providerId_keyHash?: { providerId: number; keyHash: string } }
        }) => {
          if (args.where.id !== undefined) {
            return Promise.resolve(rows.find((r) => r.id === args.where.id) ?? null)
          }
          const k = args.where.providerId_keyHash!
          return Promise.resolve(
            rows.find((r) => r.providerId === k.providerId && r.keyHash === k.keyHash) ?? null,
          )
        },
      ),
      count: jest.fn(() => Promise.resolve(rows.length)),
      create,
      update,
      delete: del,
    },
  }
  return {
    service: new ProvidersService(prisma as unknown as PrismaService),
    create,
    update,
    del,
    rows,
  }
}

const KEY = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789'

beforeEach(() => {
  process.env[SECRET_ENV] = MASTER
})
afterEach(() => {
  delete process.env[SECRET_ENV]
})

describe('ProvidersService.addKey', () => {
  test('encrypts the key and returns ONLY a masked view', async () => {
    const { service, create } = makeService()
    const view = await service.addKey('openrouter', { key: KEY })

    // Nothing in the returned object may resemble the secret.
    const serialized = JSON.stringify(view)
    expect(serialized).not.toContain(KEY)
    expect(serialized).not.toContain('abcdefghijklmnop')
    expect(Object.keys(view)).not.toContain('key')
    expect(Object.keys(view)).not.toContain('encryptedKey')
    expect(Object.keys(view)).not.toContain('keyHash')
    expect(view.maskedKey).toContain('sk-or-')

    // What was persisted: a v1 envelope + hash + mask, no plaintext.
    const data = create.mock.calls[0][0].data as Record<string, string>
    expect(data.encryptedKey.startsWith('v1:')).toBe(true)
    expect(data.encryptedKey).not.toContain(KEY)
    expect(data.keyHash).toBe(hashKey(KEY))
    expect(data.maskedKey).not.toContain('abcdefghijklmnop')
  })

  test('auto-labels and auto-orders keys so rotation has a defined sequence', async () => {
    const { service, create } = makeService([keyRow({ id: 1, priority: 0 })])
    await service.addKey('openrouter', { key: KEY })
    const data = create.mock.calls[0][0].data as Record<string, unknown>
    expect(data.label).toBe('Key 2')
    expect(data.priority).toBe(1)
  })

  test('a DUPLICATE key is refused — it would make rotation a no-op', async () => {
    const { service, create } = makeService([keyRow({ id: 3, keyHash: hashKey(KEY) })])
    await expect(service.addKey('openrouter', { key: KEY })).rejects.toThrow(ConflictException)
    await expect(service.addKey('openrouter', { key: `  ${KEY}\n` })).rejects.toThrow(
      ConflictException,
    )
    expect(create).not.toHaveBeenCalled()
  })

  test('rejects an obviously truncated key', async () => {
    const { service, create } = makeService()
    await expect(service.addKey('openrouter', { key: 'sk-1' })).rejects.toThrow(
      BadRequestException,
    )
    expect(create).not.toHaveBeenCalled()
  })

  test('a missing master secret becomes an actionable 400, not a 500', async () => {
    delete process.env[SECRET_ENV]
    const { service } = makeService()
    await expect(service.addKey('openrouter', { key: KEY })).rejects.toThrow(
      /RAYU_PROVIDER_SECRET/,
    )
  })

  test('unknown provider is a 404', async () => {
    const { service } = makeService([], null)
    await expect(service.addKey('nope', { key: KEY })).rejects.toThrow(NotFoundException)
  })
})

describe('ProvidersService.replaceKey', () => {
  test('re-seals in place and clears the failure state so the key is retried', async () => {
    const { service, update } = makeService([
      keyRow({ id: 5, status: 'invalid', lastError: 'HTTP 401', cooldownUntil: new Date() }),
    ])
    const view = await service.replaceKey('openrouter', 5, KEY)
    const data = update.mock.calls[0][0].data as Record<string, unknown>
    expect(data.encryptedKey as string).toMatch(/^v1:/)
    expect(data.keyHash).toBe(hashKey(KEY))
    expect(data).toMatchObject({ status: 'active', cooldownUntil: null, lastError: null })
    expect(JSON.stringify(view)).not.toContain(KEY)
  })

  test('refuses a replacement that duplicates ANOTHER key on the provider', async () => {
    const { service, update } = makeService([
      keyRow({ id: 5, keyHash: 'other' }),
      keyRow({ id: 6, keyHash: hashKey(KEY) }),
    ])
    await expect(service.replaceKey('openrouter', 5, KEY)).rejects.toThrow(ConflictException)
    expect(update).not.toHaveBeenCalled()
  })

  test('replacing a key with the SAME value is allowed (idempotent re-paste)', async () => {
    const { service, update } = makeService([keyRow({ id: 5, keyHash: hashKey(KEY) })])
    await service.replaceKey('openrouter', 5, KEY)
    expect(update).toHaveBeenCalled()
  })
})

describe('ProvidersService.updateKey', () => {
  test('disabling records the disabled status', async () => {
    const { service, update } = makeService([keyRow({ id: 5 })])
    await service.updateKey('openrouter', 5, { enabled: false })
    expect(update.mock.calls[0][0].data).toMatchObject({ enabled: false, status: 'disabled' })
  })

  test('re-enabling clears a stale cooldown/error so it is tried immediately', async () => {
    const { service, update } = makeService([
      keyRow({ id: 5, enabled: false, status: 'rate_limited', lastError: 'HTTP 429' }),
    ])
    await service.updateKey('openrouter', 5, { enabled: true })
    expect(update.mock.calls[0][0].data).toMatchObject({
      enabled: true,
      status: 'active',
      cooldownUntil: null,
      lastError: null,
    })
  })

  test('renumbers rotation priority and renames', async () => {
    const { service, update } = makeService([keyRow({ id: 5 })])
    await service.updateKey('openrouter', 5, { priority: 3, label: 'Prod key' })
    expect(update.mock.calls[0][0].data).toMatchObject({ priority: 3, label: 'Prod key' })
  })
})

describe('ProvidersService key scoping + deletion', () => {
  test('a key belonging to ANOTHER provider is not reachable', async () => {
    const { service } = makeService([keyRow({ id: 9, providerId: 999 })])
    await expect(service.updateKey('openrouter', 9, { enabled: false })).rejects.toThrow(
      NotFoundException,
    )
    await expect(service.replaceKey('openrouter', 9, KEY)).rejects.toThrow(NotFoundException)
    await expect(service.removeKey('openrouter', 9)).rejects.toThrow(NotFoundException)
  })

  test('removeKey deletes and reports it', async () => {
    const { service, del } = makeService([keyRow({ id: 5 })])
    await expect(service.removeKey('openrouter', 5)).resolves.toEqual({ deleted: true })
    expect(del).toHaveBeenCalledWith({ where: { id: 5 } })
  })

  test('listKeys returns masked views in rotation order', async () => {
    const { service } = makeService([
      keyRow({ id: 1, priority: 0, maskedKey: 'sk-aaa••••1111(40)' }),
      keyRow({ id: 2, priority: 1, maskedKey: 'sk-bbb••••2222(40)', status: 'rate_limited' }),
    ])
    const views = await service.listKeys('openrouter')
    expect(views).toHaveLength(2)
    expect(JSON.stringify(views)).not.toMatch(/encryptedKey|keyHash/)
    expect(views[1]).toMatchObject({ status: 'rate_limited' })
  })
})
