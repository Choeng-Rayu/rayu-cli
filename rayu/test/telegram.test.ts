import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { chunkText } from '../src/telegram/telegramApi.js'
import {
  getBotToken,
  getTelegramMode,
  isValidBotToken,
  normalizeBotToken,
  readTelegramConfig,
  saveBotToken,
  setLinkedBotUsername,
  setLinkedChat,
  setPendingToken,
  consumePendingToken,
  telegramTransportKey,
  unlink,
  writeTelegramConfig,
} from '../src/telegram/telegramConfig.js'
import { formatFileChangeReview, formatMessage, isFileChangeReviewMessage, toolIcon } from '../src/telegram/formatActivity.js'
import { handlePermissionReply } from '../src/telegram/telegramPermissions.js'
import {
  buildTelegramCommandAliases,
  toTelegramCommandName,
} from '../src/telegram/telegramBridge.js'
import { isConnectSessionActive } from '../src/telegram/telegramConnect.js'
import { getRayuConfigHomeDir } from '../src/utils/envUtils.js'

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

// ---- BYO bot token validation ----
// Regression guard for the /telegram-bot "bring your own token" step, which
// used to reject input before the user had finished entering it: the old screen
// read raw `process.stdin` 'data' events while Ink holds stdin in raw mode, so
// each keystroke — and the ESC[200~ bracketed-paste guard that precedes a paste
// — arrived as its own "line" and was regex-tested as a complete token.
describe('bot token validation', () => {
  const VALID = '123456789:AAHkQm4Zq7Xv2LpR8sT1uV3wY5zB6cD7eF8'

  test('accepts a real @BotFather token', () => {
    expect(isValidBotToken(VALID)).toBe(true)
  })

  test('accepts a token wrapped in bracketed-paste guards', () => {
    // What the terminal actually delivers on paste once Ink enables DECSET 2004.
    expect(isValidBotToken(`\u001b[200~${VALID}\u001b[201~`)).toBe(true)
    expect(normalizeBotToken(`\u001b[200~${VALID}\u001b[201~`)).toBe(VALID)
  })

  test('accepts a token that a terminal wrapped across lines', () => {
    expect(isValidBotToken('123456789:AAHkQm4Zq7Xv2Lp\r\nR8sT1uV3wY5zB6cD7eF8')).toBe(
      true,
    )
  })

  test('accepts a token pasted with surrounding quotes or spaces', () => {
    expect(isValidBotToken(`  "${VALID}"  `)).toBe(true)
    expect(normalizeBotToken(`"${VALID}"`)).toBe(VALID)
  })

  test('rejects partial input rather than calling it invalid mid-typing', () => {
    // These are the intermediate states the old code errored on.
    for (const partial of ['1', '12', '123456789', '123456789:', '123456789:AAH']) {
      expect(isValidBotToken(partial)).toBe(false)
    }
  })

  test('rejects empty and non-token input', () => {
    expect(isValidBotToken('')).toBe(false)
    expect(isValidBotToken('   ')).toBe(false)
    expect(isValidBotToken('\u001b[200~\u001b[201~')).toBe(false)
    expect(isValidBotToken('not-a-token')).toBe(false)
    expect(isValidBotToken('abc:AAHkQm4Zq7Xv2LpR8sT1uV3wY5zB6cD7')).toBe(false)
    expect(isValidBotToken('\u001b[A')).toBe(false) // up-arrow
    expect(isValidBotToken('d')).toBe(false)
  })

  test('normalizeBotToken strips control characters', () => {
    expect(normalizeBotToken(`${VALID}\r\n`)).toBe(VALID)
    expect(normalizeBotToken(`\t${VALID}\u0007`)).toBe(VALID)
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
    const cache = (getRayuConfigHomeDir as unknown as { cache?: Map<unknown, unknown> }).cache
    cache?.clear?.()
    delete process.env.TELEGRAM_BOT_TOKEN
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    if (origConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
    else process.env.RAYU_CONFIG_DIR = origConfigDir
    if (origToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN
    else process.env.TELEGRAM_BOT_TOKEN = origToken
    const cache = (getRayuConfigHomeDir as unknown as { cache?: Map<unknown, unknown> }).cache
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

  test('saveBotToken persists the normalized token, not the raw paste', () => {
    const token = '123456789:AAHkQm4Zq7Xv2LpR8sT1uV3wY5zB6cD7eF8'
    saveBotToken(`\u001b[200~ ${token} \u001b[201~`)
    expect(readTelegramConfig().botToken).toBe(token)
    expect(getBotToken()).toBe(token)
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

  // The bot a link belongs to has to be recorded, otherwise a connect can't
  // tell that the (backend-owned) default bot has changed and silently reuses a
  // link that points at a retired bot.
  test('setLinkedChat records the bot the link was made with', () => {
    setLinkedChat(42, 'alice', 'rayu_shared_bot')
    const cfg = readTelegramConfig()
    expect(cfg.linkedChatId).toBe(42)
    expect(cfg.linkedUsername).toBe('alice')
    expect(cfg.linkedBotUsername).toBe('rayu_shared_bot')
  })

  test('setLinkedChat keeps a previously recorded bot when none is passed', () => {
    setLinkedChat(42, 'alice', 'rayu_shared_bot')
    setLinkedChat(43, 'alice')
    expect(readTelegramConfig().linkedBotUsername).toBe('rayu_shared_bot')
  })

  test('setLinkedBotUsername backfills the bot on an existing link', () => {
    setLinkedChat(42, 'alice')
    expect(readTelegramConfig().linkedBotUsername).toBeUndefined()
    setLinkedBotUsername('rayu_shared_bot')
    expect(readTelegramConfig().linkedBotUsername).toBe('rayu_shared_bot')
  })

  test('unlink clears the link but keeps mode and the BYO token', () => {
    writeTelegramConfig({
      mode: 'byo',
      botToken: '123456789:AAHkQm4Zq7Xv2LpR8sT1uV3wY5zB6cD7eF8',
      linkedChatId: 42,
      linkedUsername: 'alice',
      linkedBotUsername: 'old_bot',
      pendingToken: { token: 'tok', expiresAt: Date.now() + 60_000 },
    })
    unlink()
    const cfg = readTelegramConfig()
    expect(cfg.linkedChatId).toBeUndefined()
    expect(cfg.linkedUsername).toBeUndefined()
    expect(cfg.linkedBotUsername).toBeUndefined()
    expect(cfg.pendingToken).toBeUndefined()
    // Regression: unlink() used to rewrite the file as `{ botToken }` alone,
    // dropping the explicitly chosen mode.
    expect(cfg.mode).toBe('byo')
    expect(cfg.botToken).toBe('123456789:AAHkQm4Zq7Xv2LpR8sT1uV3wY5zB6cD7eF8')
    expect(getTelegramMode()).toBe('byo')
  })

  test('unlink on a hosted link keeps hosted mode', () => {
    writeTelegramConfig({ mode: 'hosted', linkedChatId: 42 })
    unlink()
    expect(readTelegramConfig().mode).toBe('hosted')
    expect(getTelegramMode()).toBe('hosted')
  })
})

// Telegram command names can't contain hyphens, so the bridge advertises
// `/disconnect_telegram` for the CLI's `disconnect-telegram`. The inbound
// direction has to translate back or the REPL reports "Unknown skill".
describe('telegram command name translation', () => {
  test('sanitizes CLI names to Telegram-legal names', () => {
    expect(toTelegramCommandName('disconnect-telegram')).toBe('disconnect_telegram')
    expect(toTelegramCommandName('telegram-bot')).toBe('telegram_bot')
    expect(toTelegramCommandName('model')).toBe('model')
    expect(toTelegramCommandName('pr_comments')).toBe('pr_comments')
    expect(toTelegramCommandName('Add-Dir')).toBe('add_dir')
    // Telegram caps command names at 32 characters.
    expect(toTelegramCommandName('a'.repeat(40))).toHaveLength(32)
  })

  test('maps the advertised name back to the real command', () => {
    const aliases = buildTelegramCommandAliases(['disconnect-telegram', 'model', 'add-dir'])
    expect(aliases.get('disconnect_telegram')).toBe('disconnect-telegram')
    expect(aliases.get('add_dir')).toBe('add-dir')
    // Unchanged names are absent — a miss means "use it verbatim".
    expect(aliases.has('model')).toBe(false)
  })

  test('first registration wins on collision', () => {
    const aliases = buildTelegramCommandAliases(['a-b', 'a_b', 'A-B'])
    expect(aliases.get('a_b')).toBe('a-b')
  })
})
// change whenever the bot behind that transport changes — otherwise a connect to
// a different bot silently keeps using the previous bot's token.
describe('telegram transport identity', () => {
  beforeEach(() => {
    writeTelegramConfig({})
  })

  test('transport key distinguishes hosted from BYO', () => {
    writeTelegramConfig({ mode: 'hosted', linkedBotUsername: 'rayu_shared_bot' })
    const hosted = telegramTransportKey()
    writeTelegramConfig({
      mode: 'byo',
      botToken: '871213456:AAHkQm4Zq7Xv2LpR8sT1uV3wY5zB6cD7eF8',
    })
    const byo = telegramTransportKey()
    expect(hosted).not.toBe(byo)
    expect(hosted).toBe('hosted:rayu_shared_bot')
    // Only the public bot id — never any part of the secret.
    expect(byo).toBe('byo:871213456')
    expect(byo).not.toContain('AAHkQm4Zq7Xv2LpR8sT1uV3wY5zB6cD7eF8')
  })

  test('transport key changes when the BYO token is replaced', () => {
    writeTelegramConfig({ mode: 'byo', botToken: '111111111:AAAaaaAAAaaaAAAaaa' })
    const first = telegramTransportKey()
    writeTelegramConfig({ mode: 'byo', botToken: '222222222:BBBbbbBBBbbbBBBbbb' })
    expect(telegramTransportKey()).not.toBe(first)
  })

  test('transport key changes when switching bots on the same chat', () => {
    // Telegram private-chat ids are per user, not per bot: the SAME chatId is
    // valid for every bot, so the chat alone cannot identify a connection.
    writeTelegramConfig({
      mode: 'byo',
      botToken: '871213456:AAHkQm4Zq7Xv2LpR8sT1uV3wY5zB6cD7eF8',
      linkedChatId: 555,
      linkedBotUsername: 'my_own_bot',
    })
    const byo = telegramTransportKey()
    writeTelegramConfig({
      mode: 'hosted',
      botToken: '871213456:AAHkQm4Zq7Xv2LpR8sT1uV3wY5zB6cD7eF8',
      linkedChatId: 555,
      linkedBotUsername: 'rayu_shared_bot',
    })
    expect(telegramTransportKey()).not.toBe(byo)
  })

  // Pairing must NOT look like a transport change: rebuilding the bridge the
  // moment the link lands abandons the un-confirmed /start update, which Telegram
  // then redelivers to the new instance — the user sees "Linked" immediately
  // followed by "Invalid or expired token".
  test('transport key is unchanged by linking a chat', () => {
    writeTelegramConfig({
      mode: 'byo',
      botToken: '871213456:AAHkQm4Zq7Xv2LpR8sT1uV3wY5zB6cD7eF8',
    })
    const beforeLink = telegramTransportKey()
    setLinkedChat(555, 'alice', 'my_own_bot')
    expect(telegramTransportKey()).toBe(beforeLink)
  })

  test('transport key is unchanged by unlinking', () => {
    writeTelegramConfig({
      mode: 'hosted',
      linkedChatId: 555,
      linkedBotUsername: 'rayu_shared_bot',
    })
    const linked = telegramTransportKey()
    unlink()
    // unlink() clears linkedBotUsername, so the key falls back to the
    // placeholder — a *reconnect* re-resolves the real bot before activating.
    expect(telegramTransportKey()).toBe('hosted:shared')
    expect(linked).toBe('hosted:rayu_shared_bot')
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

// ---- connect wizard session state ----
describe('isConnectSessionActive', () => {
  test('returns false for unknown chatId', () => {
    expect(isConnectSessionActive(99999)).toBe(false)
  })

  test('returns false for chatId with no active session', () => {
    // No session has been started for this chatId
    expect(isConnectSessionActive(12345)).toBe(false)
  })
})
