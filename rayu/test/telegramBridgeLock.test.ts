/**
 * The bridge lock's read-only liveness probe, and the acquisition rules it shares.
 *
 * The probe is what the editor's Telegram card reports as "listening": a link record
 * can exist while no process holds the lock, and the card must tell those apart.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  acquireBridgeLock,
  isTelegramBridgeRunning,
  releaseBridgeLock,
} from '../src/telegram/telegramBridgeLock.js'

let dir: string
const previousConfigDir = process.env.RAYU_CONFIG_DIR

const lockPath = (): string => join(dir, 'telegram-bridge.lock')

/** A pid that is alive but not this process: the test runner's parent. */
const foreignLivePid = process.ppid
/** pid_max is never assigned, so it names a process that cannot exist. */
const deadPid = Number(readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim())

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-telegram-lock-'))
  process.env.RAYU_CONFIG_DIR = dir
})

afterEach(() => {
  releaseBridgeLock()
  rmSync(dir, { recursive: true, force: true })
  if (previousConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = previousConfigDir
})

describe('isTelegramBridgeRunning', () => {
  test('no lock file means nothing is polling', () => {
    expect(isTelegramBridgeRunning()).toBe(false)
  })

  test('a lock this process acquired reads as running', () => {
    expect(acquireBridgeLock()).toBe(true)
    expect(isTelegramBridgeRunning()).toBe(true)
  })

  test('releasing the lock reads as not running', () => {
    acquireBridgeLock()
    releaseBridgeLock()
    expect(isTelegramBridgeRunning()).toBe(false)
  })

  test('a live foreign holder with a fresh heartbeat reads as running', () => {
    // Empty start time: the heartbeat alone decides where /proc start times are
    // not comparable (the non-Linux rule).
    writeFileSync(lockPath(), `${foreignLivePid}::${Date.now()}`)
    expect(isTelegramBridgeRunning()).toBe(true)
  })

  test('a dead holder reads as not running', () => {
    writeFileSync(lockPath(), `${deadPid}::${Date.now()}`)
    expect(isTelegramBridgeRunning()).toBe(false)
  })

  test('a stale heartbeat reads as not running even with a live pid', () => {
    writeFileSync(lockPath(), `${foreignLivePid}::${Date.now() - 60_000}`)
    expect(isTelegramBridgeRunning()).toBe(false)
  })

  test('an old-format lock without a heartbeat is stale', () => {
    writeFileSync(lockPath(), `${foreignLivePid}:12345`)
    expect(isTelegramBridgeRunning()).toBe(false)
  })

  test('a corrupt lock reads as not running', () => {
    writeFileSync(lockPath(), 'not-a-lock')
    expect(isTelegramBridgeRunning()).toBe(false)
  })
})

describe('acquireBridgeLock', () => {
  test('respects a live foreign holder', () => {
    writeFileSync(lockPath(), `${foreignLivePid}::${Date.now()}`)
    expect(acquireBridgeLock()).toBe(false)
    // The probe must not have modified the holder's lock.
    expect(readFileSync(lockPath(), 'utf8')).toContain(`${foreignLivePid}:`)
  })

  test('reclaims a stale lock atomically', () => {
    writeFileSync(lockPath(), `${foreignLivePid}::${Date.now() - 60_000}`)
    expect(acquireBridgeLock()).toBe(true)
    expect(readFileSync(lockPath(), 'utf8').split(':')[0]).toBe(String(process.pid))
  })

  test('reclaims a dead holder’s lock', () => {
    writeFileSync(lockPath(), `${deadPid}::${Date.now()}`)
    expect(acquireBridgeLock()).toBe(true)
  })
})
