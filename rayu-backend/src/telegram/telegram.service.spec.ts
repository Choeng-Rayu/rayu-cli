import { BadRequestException } from '@nestjs/common'
import { TelegramService } from './telegram.service'
import type { PrismaService } from '../prisma/prisma.service'
import * as client from './telegram.client'

jest.mock('./telegram.client', () => ({
  tgCall: jest.fn(),
  tgGetMe: jest.fn(),
  tgGetUpdates: jest.fn(),
  tgSendMessage: jest.fn(),
}))

const mockedClient = client as jest.Mocked<typeof client>

/** Build a minimal Prisma mock exposing only what these tests touch. */
function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    telegramPairing: {
      deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
      create: jest.fn(() => Promise.resolve({})),
      findUnique: jest.fn(() => Promise.resolve(null)),
    },
    telegramLink: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
      create: jest.fn(() => Promise.resolve({})),
    },
    telegramInbound: {
      deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
      findMany: jest.fn(() => Promise.resolve([])),
      create: jest.fn(() => Promise.resolve({})),
    },
    telegramCursor: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      upsert: jest.fn(() => Promise.resolve({})),
    },
    $transaction: jest.fn((ops: unknown[]) => Promise.resolve(ops)),
    ...overrides,
  } as unknown as PrismaService
}

describe('TelegramService', () => {
  const prevToken = process.env.RAYU_SHARED_BOT_TOKEN
  const prevEnv = process.env.NODE_ENV

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.RAYU_SHARED_BOT_TOKEN = 'test-token'
    process.env.NODE_ENV = 'test' // ensures onModuleInit never starts the poller
  })
  afterAll(() => {
    process.env.RAYU_SHARED_BOT_TOKEN = prevToken
    process.env.NODE_ENV = prevEnv
  })

  it('reports configured=false and does not start the poller without a token', () => {
    process.env.RAYU_SHARED_BOT_TOKEN = ''
    const svc = new TelegramService(makePrisma())
    expect(svc.configured).toBe(false)
    svc.onModuleInit()
    expect(mockedClient.tgGetUpdates).not.toHaveBeenCalled()
  })

  it('createPairing returns a code + deep link to the shared bot', async () => {
    mockedClient.tgGetMe.mockResolvedValue('rayu_shared_bot')
    const prisma = makePrisma()
    const svc = new TelegramService(prisma)

    const res = await svc.createPairing(7)

    expect(res.code).toMatch(/^[0-9a-f]{12}$/)
    expect(res.botUsername).toBe('rayu_shared_bot')
    expect(res.deepLink).toBe(`https://t.me/rayu_shared_bot?start=${res.code}`)
    // Prior pairings for the user (and any expired) are swept before creating.
    expect(prisma.telegramPairing.deleteMany).toHaveBeenCalled()
    expect(prisma.telegramPairing.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ code: res.code, userId: 7 }),
    })
  })

  it('relaySend FORCES chat_id to the caller’s own linked chat (isolation)', async () => {
    const prisma = makePrisma()
    ;(prisma.telegramLink.findUnique as jest.Mock).mockResolvedValue({
      userId: 7,
      chatId: '55555',
      username: 'bob',
    })
    mockedClient.tgCall.mockResolvedValue({ message_id: 123 })
    const svc = new TelegramService(prisma)

    // Caller tries to target a DIFFERENT chat — must be overridden to 55555.
    const out = await svc.relaySend(7, 'sendMessage', {
      chat_id: 999999,
      text: 'hi',
    })

    expect(out).toEqual({ ok: true, result: { message_id: 123 } })
    expect(mockedClient.tgCall).toHaveBeenCalledWith('test-token', 'sendMessage', {
      chat_id: '55555',
      text: 'hi',
    })
  })

  it('relaySend rejects non-whitelisted methods', async () => {
    const svc = new TelegramService(makePrisma())
    await expect(svc.relaySend(7, 'getUpdates', {})).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })

  it('relaySend rejects when the user has no link', async () => {
    const svc = new TelegramService(makePrisma()) // findUnique → null
    await expect(
      svc.relaySend(7, 'sendMessage', { text: 'hi' }),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('fetchInbound acks consumed rows (<= after) and returns newer ones', async () => {
    const prisma = makePrisma()
    ;(prisma.telegramInbound.findMany as jest.Mock).mockResolvedValue([
      { id: 6, payload: { update_id: 6, message: { text: 'go' } } },
    ])
    ;(prisma.telegramLink.findUnique as jest.Mock).mockResolvedValue({
      userId: 7,
      chatId: '55555',
    })
    const svc = new TelegramService(prisma)

    const batch = await svc.fetchInbound(7, 5)

    expect(prisma.telegramInbound.deleteMany).toHaveBeenCalledWith({
      where: { userId: 7, id: { lte: 5 } },
    })
    expect(prisma.telegramInbound.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 7, id: { gt: 5 } } }),
    )
    expect(batch).toEqual({
      linked: true,
      updates: [{ id: 6, update: { update_id: 6, message: { text: 'go' } } }],
    })
  })
})
