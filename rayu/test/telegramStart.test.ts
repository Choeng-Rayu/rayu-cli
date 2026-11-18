/**
 * Which process attaches itself to the linked Telegram chat, and why.
 *
 * The regression this guards: the bridge was started only from the Ink REPL hook, so a
 * headless VS Code engine never polled Telegram even though the link existed. The rule
 * below is what both hosts now ask, so its edge cases get exercised directly.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { setHostedRouter } from '../src/telegram/telegramApi.js'
import {
  linkOwnedByAnotherAccount,
  saveAutoAttach,
  saveBotToken,
  setLinkedChat,
  setPendingToken,
  setTelegramMode,
} from '../src/telegram/telegramConfig.js'
import {
  hasPendingByoPairing,
  hostedLinkOwnedByAnotherAccount,
  isLinkOrphaned,
  resolveTelegramTransport,
  shouldAutoAttach,
  shouldStartTelegramBridge,
  type AutoAttachInput,
  type OrphanedLinkInput,
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

// ── orphaned links ─────────────────────────────────────────────────────────────
// The incident this guards: the linked session exited, every live session is a
// different workspace, so nothing polls and chat messages park on the backend
// forever with no error anywhere.
describe('isLinkOrphaned', () => {
  const orphanBase: OrphanedLinkInput = {
    linkedChatId: 42,
    autoReconnect: true,
    remembered: { sessionId: 'session-a', cwd: '/work/project' },
    liveRecords: [{ sessionId: 'session-b', cwd: '/work/other' }],
  }

  test('a link whose remembered session is gone is orphaned', () => {
    expect(isLinkOrphaned(orphanBase)).toBe(true)
  })

  test('no link is never orphaned', () => {
    expect(isLinkOrphaned({ ...orphanBase, linkedChatId: undefined })).toBe(false)
  })

  test('auto-reconnect off is left alone, not adopted', () => {
    expect(isLinkOrphaned({ ...orphanBase, autoReconnect: false })).toBe(false)
  })

  test('a link with no memory at all has no session to answer it', () => {
    expect(isLinkOrphaned({ ...orphanBase, remembered: undefined })).toBe(true)
  })

  test('a live record with the remembered id keeps the link alive', () => {
    expect(
      isLinkOrphaned({
        ...orphanBase,
        liveRecords: [{ sessionId: 'session-a', cwd: '/work/moved' }],
      }),
    ).toBe(false)
  })

  test('a live record in the remembered cwd keeps the link alive after a resume', () => {
    // `/resume` mutates the session id in place; the directory is the stable identity.
    expect(
      isLinkOrphaned({
        ...orphanBase,
        liveRecords: [{ sessionId: 'session-resumed', cwd: '/work/project' }],
      }),
    ).toBe(false)
  })

  test('an empty remembered id matches by directory only', () => {
    const remembered = { sessionId: '', cwd: '/work/project' }
    expect(
      isLinkOrphaned({
        ...orphanBase,
        remembered,
        liveRecords: [{ sessionId: '', cwd: '/work/project' }],
      }),
    ).toBe(false)
    expect(
      isLinkOrphaned({
        ...orphanBase,
        remembered,
        liveRecords: [{ sessionId: '', cwd: '/work/other' }],
      }),
    ).toBe(true)
  })

  test('an empty registry orphans any remembered link', () => {
    expect(isLinkOrphaned({ ...orphanBase, liveRecords: [] })).toBe(true)
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

// ── machine-wide link, per-account ownership ──────────────────────────────────
// The incident this guards: the CLI and the editor were signed into DIFFERENT Rayu
// accounts. The editor adopted the CLI's shared hosted link, polled the backend as
// its own (link-less) account, was told "no link", and wiped the machine-wide cache —
// destroying the CLI's connection. A non-owning account must display/route to the
// link but never lead or clear it.
describe('hosted link ownership across accounts', () => {
  let dir: string
  const prevConfig = process.env.RAYU_CONFIG_DIR
  const prevAuth = process.env.RAYU_AUTH_CONFIG_DIR

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rayu-tg-owner-'))
    process.env.RAYU_CONFIG_DIR = dir
    process.env.RAYU_AUTH_CONFIG_DIR = join(dir, 'auth')
    mkdirSync(join(dir, 'auth'), { recursive: true })
  })

  afterEach(() => {
    setHostedRouter(null)
    rmSync(dir, { recursive: true, force: true })
    if (prevConfig === undefined) delete process.env.RAYU_CONFIG_DIR
    else process.env.RAYU_CONFIG_DIR = prevConfig
    if (prevAuth === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
    else process.env.RAYU_AUTH_CONFIG_DIR = prevAuth
  })

  /** Sign this surface into the given Rayu account id. */
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

  /** A hosted link owned by account 233, remembered for this workspace. */
  function linkOwnedBy233(): void {
    setTelegramMode('hosted')
    setLinkedChat(964086904, 'President_Alien', 'rayu_clawbot', 233)
    saveAutoAttach('session-a', '/work/project')
  }

  test('pure predicate: mismatch is another account, match/unknown is not', () => {
    expect(linkOwnedByAnotherAccount(233, 307)).toBe(true)
    expect(linkOwnedByAnotherAccount(233, 233)).toBe(false)
    expect(linkOwnedByAnotherAccount(undefined, 307)).toBe(false)
    expect(linkOwnedByAnotherAccount(233, undefined)).toBe(false)
  })

  test('a different-account surface sees the link as owned by another', () => {
    linkOwnedBy233()
    signInAs(307)
    expect(hostedLinkOwnedByAnotherAccount()).toBe(true)
  })

  test('a different-account surface does NOT start the bridge', () => {
    linkOwnedBy233()
    signInAs(307)
    expect(shouldStartTelegramBridge()).toBe(false)
  })

  test('the owning account is not gated', () => {
    linkOwnedBy233()
    signInAs(233)
    expect(hostedLinkOwnedByAnotherAccount()).toBe(false)
  })

  test('a link with no recorded owner is not gated (back-compat)', () => {
    setTelegramMode('hosted')
    setLinkedChat(42, 'someone', 'rayu_clawbot') // no accountId
    signInAs(307)
    expect(hostedLinkOwnedByAnotherAccount()).toBe(false)
  })

  test('BYO links are never account-gated', () => {
    saveBotToken('123456789:AAHkQm4Zq7Xv2LpR8sT1uV3wY5zB6cD7eF8')
    setTelegramMode('byo')
    setLinkedChat(42, 'someone', undefined, 233)
    signInAs(307)
    expect(hostedLinkOwnedByAnotherAccount()).toBe(false)
  })
})
