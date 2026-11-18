/**
 * Self-healing of the machine-wide Telegram link cache from the backend.
 *
 * The card and the chat filter read telegram.json, but that cache can be wiped.
 * The live hosted bridge restores it by asking the backend AS ITS OWN ACCOUNT and
 * writing back only a `linked:true` answer — so it can never stamp a wrong owner,
 * and a non-owning account (linked:false) writes nothing.
 *
 * No mock.module (process-wide in Bun): a non-expired session file makes
 * getValidRayuAccessToken return locally, and globalThis.fetch is stubbed for the
 * single /telegram/link call.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { reconcileHostedLinkCache } from '../src/telegram/telegramBridge.js'
import { readTelegramConfig, setTelegramMode } from '../src/telegram/telegramConfig.js'

let dir: string
const prevConfig = process.env.RAYU_CONFIG_DIR
const prevAuth = process.env.RAYU_AUTH_CONFIG_DIR
const prevApi = process.env.RAYU_API_URL
const realFetch = globalThis.fetch

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-tg-reconcile-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_AUTH_CONFIG_DIR = join(dir, 'auth')
  process.env.RAYU_API_URL = 'https://backend.test/api'
  mkdirSync(join(dir, 'auth'), { recursive: true })
  setTelegramMode('hosted')
})

afterEach(() => {
  globalThis.fetch = realFetch
  rmSync(dir, { recursive: true, force: true })
  if (prevConfig === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = prevConfig
  if (prevAuth === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
  else process.env.RAYU_AUTH_CONFIG_DIR = prevAuth
  if (prevApi === undefined) delete process.env.RAYU_API_URL
  else process.env.RAYU_API_URL = prevApi
})

function signInAs(id: number): void {
  writeFileSync(
    join(dir, 'auth', 'rayu-auth.json'),
    JSON.stringify({
      accessToken: 't',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id, email: null, displayName: null, avatarUrl: null, role: 'user' },
    }),
  )
}

function stubLink(body: { linked: boolean; chatId?: string; username?: string | null }): void {
  globalThis.fetch = (async () =>
    ({ ok: true, json: async () => body }) as unknown as Response) as unknown as typeof fetch
}

describe('reconcileHostedLinkCache', () => {
  test('restores a wiped cache and stamps the owning account', async () => {
    signInAs(233)
    stubLink({ linked: true, chatId: '964086904', username: 'President_Alien' })
    expect(readTelegramConfig().linkedChatId).toBeUndefined()

    await reconcileHostedLinkCache()

    const cfg = readTelegramConfig()
    expect(cfg.linkedChatId).toBe(964086904)
    expect(cfg.linkedUsername).toBe('President_Alien')
    expect(cfg.linkedAccountId).toBe(233)
  })

  test('a non-owning account (linked:false) writes nothing', async () => {
    signInAs(307)
    stubLink({ linked: false })

    await reconcileHostedLinkCache()

    expect(readTelegramConfig().linkedChatId).toBeUndefined()
    expect(readTelegramConfig().linkedAccountId).toBeUndefined()
  })

  test('does not rewrite an already-correct cache', async () => {
    signInAs(233)
    stubLink({ linked: true, chatId: '964086904', username: 'President_Alien' })
    await reconcileHostedLinkCache()
    const before = JSON.stringify(readTelegramConfig())

    await reconcileHostedLinkCache()
    expect(JSON.stringify(readTelegramConfig())).toBe(before)
  })

  test('a backend failure leaves the cache untouched (fail-soft)', async () => {
    signInAs(233)
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch

    await reconcileHostedLinkCache()
    expect(readTelegramConfig().linkedChatId).toBeUndefined()
  })
})
