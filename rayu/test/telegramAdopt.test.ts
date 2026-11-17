/**
 * Orphaned-link adoption, through the REAL seams (config files, session registry,
 * bridge lock) — no module mocks, because mock.module is process-wide in Bun and
 * stubbing the bridge here would break every other telegram test in the same run.
 *
 * The leader-writes-attachment branch cannot be exercised without starting a real
 * poll loop, so these tests cover every decision AROUND it: when adoption refuses,
 * and the rule that a no-op handle (a live leader holds the lock) never re-points
 * the attachment. The pure orphan rule itself is covered in telegramStart.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getSessionId } from '../src/bootstrap/state.js'
import {
  saveAutoAttach,
  saveBotToken,
  setAutoReconnect,
  setLinkedChat,
  setTelegramMode,
} from '../src/telegram/telegramConfig.js'
import { adoptOrphanedTelegramLink } from '../src/telegram/telegramStart.js'

const VALID_TOKEN = '123456789:AAHkQm4Zq7Xv2LpR8sT1uV3wY5zB6cD7eF8'
/** A session that is not this process and does not exist. */
const DEAD = { sessionId: 'dead-session', cwd: '/nonexistent-workspace' }

let dir: string
const previousConfigDir = process.env.RAYU_CONFIG_DIR
const previousAuthDir = process.env.RAYU_AUTH_CONFIG_DIR

const attachmentPath = (): string => join(dir, 'telegram-attached.json')
const lockPath = (): string => join(dir, 'telegram-bridge.lock')

/** A live foreign bridge leader: the test runner's parent, fresh heartbeat. */
function writeForeignLock(): void {
  writeFileSync(lockPath(), `${process.ppid}::${Date.now()}`)
}

/** A registry record for a live session (this process's pid passes the liveness probe). */
function writeLiveRecord(sessionId: string, cwd: string): void {
  const sessions = join(dir, 'sessions')
  mkdirSync(sessions, { recursive: true })
  writeFileSync(
    join(sessions, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId, cwd, startedAt: Date.now() }),
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-telegram-adopt-'))
  process.env.RAYU_CONFIG_DIR = dir
  // No Rayu session: hosted transport must resolve to null, never the network.
  process.env.RAYU_AUTH_CONFIG_DIR = join(dir, 'auth')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (previousConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = previousConfigDir
  if (previousAuthDir === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
  else process.env.RAYU_AUTH_CONFIG_DIR = previousAuthDir
})

describe('adoptOrphanedTelegramLink', () => {
  test('no link: nothing to adopt', async () => {
    expect(await adoptOrphanedTelegramLink()).toBeNull()
    expect(existsSync(attachmentPath())).toBe(false)
  })

  test('auto-reconnect off is an explicit user choice, not an orphan', async () => {
    setLinkedChat(42)
    saveAutoAttach(DEAD.sessionId, DEAD.cwd)
    setAutoReconnect(false)
    expect(await adoptOrphanedTelegramLink()).toBeNull()
    expect(existsSync(attachmentPath())).toBe(false)
  })

  test('a live remembered session keeps its link — no adoption', async () => {
    setLinkedChat(42)
    saveAutoAttach('live-session', '/live-workspace')
    writeLiveRecord('live-session', '/live-workspace')
    expect(await adoptOrphanedTelegramLink()).toBeNull()
    expect(existsSync(attachmentPath())).toBe(false)
  })

  test('hosted without a Rayu session cannot adopt (no transport)', async () => {
    setTelegramMode('hosted')
    setLinkedChat(42)
    saveAutoAttach(DEAD.sessionId, DEAD.cwd)
    expect(await adoptOrphanedTelegramLink()).toBeNull()
    expect(existsSync(attachmentPath())).toBe(false)
  })

  test('a live bridge leader is never stolen from: no-op handle, no attachment write', async () => {
    saveBotToken(VALID_TOKEN)
    setTelegramMode('byo')
    setLinkedChat(42)
    saveAutoAttach(DEAD.sessionId, DEAD.cwd)
    writeForeignLock()

    const handle = await adoptOrphanedTelegramLink()
    // The lock holder won; this process got the no-op handle and must leave the
    // routing decision alone rather than re-point the chat at itself.
    expect(handle).not.toBeNull()
    expect(handle?.isNoOp).toBe(true)
    expect(existsSync(attachmentPath())).toBe(false)
  })

  test('a link with no memory is orphaned too (decision reaches the transport)', async () => {
    setTelegramMode('hosted')
    setLinkedChat(42)
    // No autoAttach at all; hosted without a session still resolves to null, but
    // the orphan decision must have passed for the transport to be consulted.
    expect(await adoptOrphanedTelegramLink()).toBeNull()
    expect(existsSync(attachmentPath())).toBe(false)
  })

  test('the adopting process is the one the memory names after a restart', async () => {
    // When the memory already matches THIS process, the normal rule applies and
    // adoption defers to it (startTelegramBridge), which here cannot resolve a
    // hosted transport — but it must not write a second attachment either.
    setTelegramMode('hosted')
    setLinkedChat(42)
    saveAutoAttach(getSessionId(), process.cwd())
    expect(await adoptOrphanedTelegramLink()).toBeNull()
    expect(existsSync(attachmentPath())).toBe(false)
  })
})
