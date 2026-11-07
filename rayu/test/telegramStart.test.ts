/**
 * Which process attaches itself to the linked Telegram chat, and why.
 *
 * The regression this guards: the bridge was started only from the Ink REPL hook, so a
 * headless VS Code engine never polled Telegram even though the link existed. The rule
 * below is what both hosts now ask, so its edge cases get exercised directly.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { setHostedRouter } from '../src/telegram/telegramApi.js'
import {
  saveBotToken,
  setPendingToken,
  setTelegramMode,
} from '../src/telegram/telegramConfig.js'
import {
  hasPendingByoPairing,
  resolveTelegramTransport,
  shouldAutoAttach,
  shouldStartTelegramBridge,
  type AutoAttachInput,
} from '../src/telegram/telegramStart.js'

const base: AutoAttachInput = {
  linkedChatId: 42,
  autoReconnect: true,
  remembered: { sessionId: 'session-a', cwd: '/work/project' },
  sessionId: 'session-a',
  cwd: '/work/project',
}

describe('shouldAutoAttach', () => {
  test('attaches the remembered session', () => {
    expect(shouldAutoAttach(base)).toBe(true)
  })

  test('refuses when nothing is linked', () => {
    expect(shouldAutoAttach({ ...base, linkedChatId: undefined })).toBe(false)
  })

  test('refuses when auto-reconnect is off', () => {
    expect(shouldAutoAttach({ ...base, autoReconnect: false })).toBe(false)
  })

  test('refuses when no session was ever remembered', () => {
    expect(shouldAutoAttach({ ...base, remembered: undefined })).toBe(false)
  })

  test('a different session in a different workspace does not attach', () => {
    expect(
      shouldAutoAttach({ ...base, sessionId: 'session-b', cwd: '/work/other' }),
    ).toBe(false)
  })

  test('matches on the working directory after a resume changed the id', () => {
    // `/resume` mutates a session's id in place; the directory is the stable identity.
    expect(shouldAutoAttach({ ...base, sessionId: 'session-resumed' })).toBe(true)
  })

  test('matches on the session id when the directory moved', () => {
    expect(shouldAutoAttach({ ...base, cwd: '/work/moved' })).toBe(true)
  })

  test('an empty remembered id never matches by id, only by directory', () => {
    // The editor writes '' until a fresh conversation's engine reports an id.
    const remembered = { sessionId: '', cwd: '/work/project' }
    expect(shouldAutoAttach({ ...base, remembered })).toBe(true)
    expect(
      shouldAutoAttach({ ...base, remembered, sessionId: '', cwd: '/work/other' }),
    ).toBe(false)
  })
})

// ── transport resolution ───────────────────────────────────────────────────────
// Shared with the REPL hook, so a change here changes both hosts.
describe('resolveTelegramTransport', () => {
  const VALID = '123456789:AAHkQm4Zq7Xv2LpR8sT1uV3wY5zB6cD7eF8'
  let dir: string
  const previousConfigDir = process.env.RAYU_CONFIG_DIR
  const previousAuthDir = process.env.RAYU_AUTH_CONFIG_DIR

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rayu-telegram-start-'))
    process.env.RAYU_CONFIG_DIR = dir
    delete process.env.RAYU_AUTH_CONFIG_DIR
  })

  afterEach(() => {
    setHostedRouter(null)
    rmSync(dir, { recursive: true, force: true })
    if (previousConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
    else process.env.RAYU_CONFIG_DIR = previousConfigDir
    if (previousAuthDir === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
    else process.env.RAYU_AUTH_CONFIG_DIR = previousAuthDir
  })

  test('BYO returns the saved bot token', () => {
    saveBotToken(VALID)
    setTelegramMode('byo')
    const transport = resolveTelegramTransport()
    expect(transport?.token).toBe(VALID)
    expect(transport?.transportKey).toBe(`byo:${VALID.split(':')[0]}`)
  })

  test('BYO without a token cannot connect', () => {
    setTelegramMode('byo')
    expect(resolveTelegramTransport()).toBeNull()
  })

  test('hosted without a Rayu session cannot connect', () => {
    setTelegramMode('hosted')
    expect(resolveTelegramTransport()).toBeNull()
  })

  // ── starting a bridge to finish a BYO pairing ────────────────────────────────
  // The pending token is consumed by the bridge, so a pairing would hang forever if
  // this were gated on a link that does not exist yet.
  test('a live BYO pairing starts a bridge even with no link yet', () => {
    saveBotToken(VALID)
    setTelegramMode('byo')
    setPendingToken('pair-token', 10 * 60 * 1000)
    expect(hasPendingByoPairing()).toBe(true)
    expect(shouldStartTelegramBridge()).toBe(true)
  })

  test('an expired BYO pairing starts nothing', () => {
    saveBotToken(VALID)
    setTelegramMode('byo')
    setPendingToken('pair-token', -1)
    expect(hasPendingByoPairing()).toBe(false)
    expect(shouldStartTelegramBridge()).toBe(false)
  })

  test('a hosted configuration never treats a pending token as a BYO pairing', () => {
    saveBotToken(VALID)
    setTelegramMode('hosted')
    setPendingToken('pair-token', 10 * 60 * 1000)
    expect(hasPendingByoPairing()).toBe(false)
  })

  test('nothing starts without a link, a memory, or a pairing', () => {
    saveBotToken(VALID)
    setTelegramMode('byo')
    expect(shouldStartTelegramBridge()).toBe(false)
  })
})
