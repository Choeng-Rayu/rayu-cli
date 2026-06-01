import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { chunkText } from '../src/telegram/telegramApi.js'
import {
  getBotToken,
  readTelegramConfig,
  setPendingToken,
  consumePendingToken,
  writeTelegramConfig,
} from '../src/telegram/telegramConfig.js'
import { formatMessage } from '../src/telegram/formatActivity.js'
import { getClaudeConfigHomeDir } from '../src/utils/envUtils.js'

// ---- chunkText ----
describe('chunkText', () => {
  test('returns single chunk for short text', () => {
    expect(chunkText('hello')).toEqual(['hello'])
  })

  test('chunks text exceeding 4096 chars', () => {
    const long = 'a'.repeat(5000)
    const chunks = chunkText(long)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4096)
  })

  test('joins all chunks back to original', () => {
    const long = 'a'.repeat(3000) + '\n' + 'b'.repeat(3000)
    const chunks = chunkText(long)
    expect(chunks.join('')).toBe(long)
  })
})

// ---- telegramConfig ----
describe('telegramConfig', () => {
  let tmpDir: string
  const origConfigDir = process.env.RAYU_CONFIG_DIR
  const origToken = process.env.TELEGRAM_BOT_TOKEN

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rayu-tg-test-'))
    process.env.RAYU_CONFIG_DIR = tmpDir
    // Reset memoize cache so the new dir is picked up
    const cache = (getClaudeConfigHomeDir as unknown as { cache?: Map<unknown, unknown> }).cache
    cache?.clear?.()
    delete process.env.TELEGRAM_BOT_TOKEN
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    if (origConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
    else process.env.RAYU_CONFIG_DIR = origConfigDir
    if (origToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN
    else process.env.TELEGRAM_BOT_TOKEN = origToken
    const cache = (getClaudeConfigHomeDir as unknown as { cache?: Map<unknown, unknown> }).cache
    cache?.clear?.()
  })

  test('getBotToken reads TELEGRAM_BOT_TOKEN env', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token-123'
    expect(getBotToken()).toBe('test-token-123')
  })

  test('getBotToken returns undefined when unset', () => {
    expect(getBotToken()).toBeUndefined()
  })

  test('readTelegramConfig returns empty object before any write', () => {
    expect(readTelegramConfig()).toEqual({})
  })

  test('setPendingToken + consumePendingToken succeeds with correct token', () => {
    setPendingToken('tok123', 60_000)
    const result = consumePendingToken('tok123', 42, 'alice')
    expect(result).not.toBeNull()
    expect(result?.linkedChatId).toBe(42)
    expect(result?.linkedUsername).toBe('alice')
  })

  test('consumePendingToken fails on wrong token', () => {
    setPendingToken('tok123', 60_000)
    expect(consumePendingToken('wrong', 42, 'alice')).toBeNull()
  })

  test('consumePendingToken fails on expired token', () => {
    writeTelegramConfig({ pendingToken: { token: 'tok', expiresAt: Date.now() - 1 } })
    expect(consumePendingToken('tok', 1, undefined)).toBeNull()
  })

  test('consumePendingToken is single-use (clears pendingToken)', () => {
    setPendingToken('tok123', 60_000)
    consumePendingToken('tok123', 42, 'alice')
    expect(readTelegramConfig().pendingToken).toBeUndefined()
  })
})

// ---- formatActivity ----
describe('formatMessage', () => {
  test('formats text block', () => {
    const msg = { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } }
    expect(formatMessage(msg)).toBe('Hello world')
  })

  test('formats thinking block with emoji prefix', () => {
    const msg = { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'pondering' }] } }
    expect(formatMessage(msg)).toBe('💭 pondering')
  })

  test('formats tool_use block with wrench emoji', () => {
    const msg = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'bash', input: { command: 'ls' } }] } }
    const text = formatMessage(msg)!
    expect(text).toContain('🔧')
    expect(text).toContain('bash')
  })

  test('formats tool_result block with arrow prefix', () => {
    const msg = { type: 'user', message: { content: [{ type: 'tool_result', content: 'output.txt' }] } }
    expect(formatMessage(msg)).toContain('↳')
    expect(formatMessage(msg)).toContain('output.txt')
  })

  test('returns null for isMeta messages', () => {
    const msg = { type: 'assistant', isMeta: true, message: { content: [{ type: 'text', text: 'hidden' }] } }
    expect(formatMessage(msg)).toBeNull()
  })

  test('returns null for empty content', () => {
    expect(formatMessage({ type: 'assistant', message: { content: [] } })).toBeNull()
  })

  test('truncates long tool args to under 300 chars total', () => {
    const input = { command: 'x'.repeat(200) }
    const msg = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'bash', input }] } }
    expect(formatMessage(msg)!.length).toBeLessThan(300)
  })

  test('handles string content body', () => {
    const msg = { type: 'assistant', message: { content: 'plain string message' } }
    expect(formatMessage(msg)).toBe('plain string message')
  })
})
