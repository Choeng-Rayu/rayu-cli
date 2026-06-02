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
import { formatFileChangeReview, formatMessage, isFileChangeReviewMessage, toolIcon } from '../src/telegram/formatActivity.js'
import { handlePermissionReply } from '../src/telegram/telegramPermissions.js'
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

// ---- toolIcon ----
describe('toolIcon', () => {
  test('bash tool gets terminal icon', () => {
    expect(toolIcon('Bash')).toBe('🖥️')
    expect(toolIcon('bash')).toBe('🖥️')
  })

  test('file read tool gets book icon', () => {
    expect(toolIcon('FileRead')).toBe('📖')
    expect(toolIcon('file_read')).toBe('📖')
  })

  test('file write tool gets pencil icon', () => {
    expect(toolIcon('FileWrite')).toBe('✏️')
    expect(toolIcon('file_write')).toBe('✏️')
  })

  test('file edit tool gets memo icon', () => {
    expect(toolIcon('FileEdit')).toBe('📝')
    expect(toolIcon('str_replace_based_edit_tool')).toBe('📝')
  })

  test('glob tool gets magnifier icon', () => {
    expect(toolIcon('Glob')).toBe('🔍')
  })

  test('grep tool gets magnifier-right icon', () => {
    expect(toolIcon('Grep')).toBe('🔎')
  })

  test('web fetch/search tools get globe icon', () => {
    expect(toolIcon('WebFetch')).toBe('🌐')
    expect(toolIcon('WebSearch')).toBe('🌐')
  })

  test('image gen gets art palette icon', () => {
    expect(toolIcon('ImageGen')).toBe('🎨')
    expect(toolIcon('generate_image')).toBe('🎨')
  })

  test('video gen gets movie icon', () => {
    expect(toolIcon('VideoGen')).toBe('🎬')
    expect(toolIcon('generate_video')).toBe('🎬')
  })

  test('agent tool gets robot icon', () => {
    expect(toolIcon('Agent')).toBe('🤖')
  })

  test('todo write gets clipboard icon', () => {
    expect(toolIcon('TodoWrite')).toBe('📋')
  })

  test('unknown tool falls back to wrench', () => {
    expect(toolIcon('SomeUnknownTool')).toBe('🔧')
  })

  test('hyphenated names are normalized', () => {
    expect(toolIcon('file-read')).toBe('📖')
    expect(toolIcon('file-write')).toBe('✏️')
    expect(toolIcon('web-fetch')).toBe('🌐')
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

  test('formats bash tool_use with terminal icon', () => {
    const msg = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }
    const text = formatMessage(msg)!
    expect(text).toContain('🖥️')
    expect(text).toContain('Bash')
  })

  test('formats file read tool_use with book icon', () => {
    const msg = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'FileRead', input: { path: '/tmp/foo' } }] } }
    const text = formatMessage(msg)!
    expect(text).toContain('📖')
    expect(text).toContain('FileRead')
  })

  test('formats file write tool_use with pencil icon', () => {
    const msg = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'FileWrite', input: { path: '/tmp/foo' } }] } }
    const text = formatMessage(msg)!
    expect(text).toContain('✏️')
  })

  test('formats file edit tool_use with memo icon', () => {
    const msg = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'FileEdit', input: {} }] } }
    const text = formatMessage(msg)!
    expect(text).toContain('📝')
  })

  test('formats image gen tool_use with art palette icon', () => {
    const msg = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ImageGen', input: { prompt: 'cat' } }] } }
    const text = formatMessage(msg)!
    expect(text).toContain('🎨')
  })

  test('unknown tool falls back to wrench icon', () => {
    const msg = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SomeTool', input: {} }] } }
    const text = formatMessage(msg)!
    expect(text).toContain('🔧')
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

  test('truncates long tool_result to under MAX_RESULT_CHARS', () => {
    const msg = { type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(1000) }] } }
    const text = formatMessage(msg)!
    expect(text.length).toBeLessThan(600)
    expect(text).toContain('↳')
  })
})

// ---- permission reply "always" ----
describe('handlePermissionReply (always)', () => {
  test('returns false when no pending permissions', () => {
    expect(handlePermissionReply('always')).toBe(false)
  })

  test('returns false for unrecognized text when no pending', () => {
    expect(handlePermissionReply('maybe')).toBe(false)
  })
})

// ---- isFileChangeReviewMessage ----
describe('isFileChangeReviewMessage', () => {
  test('returns true for a valid file change review message', () => {
    const msg = {
      type: 'system',
      subtype: 'file_change_review',
      review: { totalFiles: 1, totalAdditions: 2, totalRemovals: 1, files: [] },
    }
    expect(isFileChangeReviewMessage(msg)).toBe(true)
  })

  test('returns false for assistant message', () => {
    expect(isFileChangeReviewMessage({ type: 'assistant', message: { content: [] } })).toBe(false)
  })

  test('returns false for system message with wrong subtype', () => {
    expect(isFileChangeReviewMessage({ type: 'system', subtype: 'other' })).toBe(false)
  })

  test('returns false for null', () => {
    expect(isFileChangeReviewMessage(null)).toBe(false)
  })
})

// ---- formatFileChangeReview ----
describe('formatFileChangeReview', () => {
  const makeReview = (files: Array<{ displayPath: string; additions: number; removals: number; isCreated?: boolean }>) => ({
    type: 'system',
    subtype: 'file_change_review',
    review: {
      totalFiles: files.length,
      totalAdditions: files.reduce((s, f) => s + f.additions, 0),
      totalRemovals: files.reduce((s, f) => s + f.removals, 0),
      files,
    },
  })

  test('shows file count, additions, and removals in header', () => {
    const msg = makeReview([{ displayPath: 'src/foo.ts', additions: 8, removals: 3 }])
    const text = formatFileChangeReview(msg)
    expect(text).toContain('1 file')
    expect(text).toContain('+8')
    expect(text).toContain('−3')
  })

  test('shows each file with its stats', () => {
    const msg = makeReview([
      { displayPath: 'src/foo.ts', additions: 8, removals: 3 },
      { displayPath: 'src/bar.ts', additions: 2, removals: 0 },
    ])
    const text = formatFileChangeReview(msg)
    expect(text).toContain('src/foo.ts')
    expect(text).toContain('src/bar.ts')
    expect(text).toContain('+8')
    expect(text).toContain('+2')
  })

  test('marks new files with ✨ icon', () => {
    const msg = makeReview([{ displayPath: 'src/new.ts', additions: 5, removals: 0, isCreated: true }])
    const text = formatFileChangeReview(msg)
    expect(text).toContain('✨')
    expect(text).toContain('new file')
  })

  test('includes undo and review_detail instructions', () => {
    const msg = makeReview([{ displayPath: 'src/foo.ts', additions: 1, removals: 1 }])
    const text = formatFileChangeReview(msg)
    expect(text).toContain('/undo')
    expect(text).toContain('/review_detail')
  })

  test('truncates to 8 files and shows overflow count', () => {
    const files = Array.from({ length: 10 }, (_, i) => ({
      displayPath: `src/file${i}.ts`,
      additions: 1,
      removals: 0,
    }))
    const msg = makeReview(files)
    const text = formatFileChangeReview(msg)
    expect(text).toContain('… and 2 more')
    expect(text).toContain('src/file0.ts')
    expect(text).not.toContain('src/file9.ts')
  })

  test('uses plural "files" for multiple files', () => {
    const msg = makeReview([
      { displayPath: 'a.ts', additions: 1, removals: 0 },
      { displayPath: 'b.ts', additions: 1, removals: 0 },
    ])
    expect(formatFileChangeReview(msg)).toContain('2 files')
  })

  test('uses singular "file" for one file', () => {
    const msg = makeReview([{ displayPath: 'a.ts', additions: 1, removals: 0 }])
    expect(formatFileChangeReview(msg)).toContain('1 file')
  })
})
