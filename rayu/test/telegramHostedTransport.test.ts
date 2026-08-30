import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Mock the backend client so the transport is tested in isolation (no network,
// no rayuSession/token dependency).
let updatesCalls: number[] = []
let updatesQueue: Array<{ id: number; update: unknown }> = []
let relayCalls: Array<{ method: string; params: unknown }> = []

mock.module('../src/telegram/telegramHostedApi.ts', () => ({
  getHostedBotInfo: async () => ({ configured: true, username: 'rayu_shared_bot' }),
  getHostedUpdates: async (after: number) => {
    updatesCalls.push(after)
    const updates = updatesQueue
    updatesQueue = []
    return { kind: 'ok', batch: { linked: true, updates } }
  },
  relayHostedSend: async (method: string, params: unknown) => {
    relayCalls.push({ method, params })
    return { message_id: 42 }
  },
}))

const { createHostedRouter } = await import('../src/telegram/telegramTransport.ts')

describe('createHostedRouter', () => {
  beforeEach(() => {
    updatesCalls = []
    updatesQueue = []
    relayCalls = []
  })

  test('ignores the bridge offset and advances its own row-id cursor', async () => {
    const router = createHostedRouter()

    const u1 = { update_id: 100, message: { message_id: 1, text: 'a', chat: { id: 55 } } }
    const u2 = { update_id: 101, message: { message_id: 2, text: 'b', chat: { id: 55 } } }
    updatesQueue = [
      { id: 3, update: u1 },
      { id: 5, update: u2 },
    ]
    const first = await router.getUpdates(0)
    expect(updatesCalls[0]).toBe(0) // first poll acks nothing
    expect(first).toEqual({ kind: 'ok', updates: [u1, u2] })

    const u3 = { update_id: 102, message: { message_id: 3, text: 'c', chat: { id: 55 } } }
    updatesQueue = [{ id: 8, update: u3 }]
    const second = await router.getUpdates(999999) // bridge offset intentionally ignored
    expect(updatesCalls[1]).toBe(5) // advanced to the max row id from the first batch
    expect(second).toEqual({ kind: 'ok', updates: [u3] })
  })

  test('call(getMe) returns the shared bot username', async () => {
    const router = createHostedRouter()
    expect(await router.call('getMe', {})).toEqual({ username: 'rayu_shared_bot' })
    expect(relayCalls).toHaveLength(0)
  })

  test('call(setMyCommands) is a no-op (backend owns the shared bot command list)', async () => {
    const router = createHostedRouter()
    expect(await router.call('setMyCommands', { commands: [] })).toEqual({})
    expect(relayCalls).toHaveLength(0)
  })

  test('call(sendMessage) relays through the backend and returns its result', async () => {
    const router = createHostedRouter()
    const res = await router.call('sendMessage', { text: 'hi', chat_id: 1 })
    expect(res).toEqual({ message_id: 42 })
    expect(relayCalls).toEqual([
      { method: 'sendMessage', params: { text: 'hi', chat_id: 1 } },
    ])
  })

  test('botUsername() resolves the shared bot @username', async () => {
    const router = createHostedRouter()
    expect(await router.botUsername()).toBe('rayu_shared_bot')
  })
})
