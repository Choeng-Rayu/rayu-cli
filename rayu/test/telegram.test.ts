import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { chunkText, buildForceReplyBody, setHostedRouter } from '../src/telegram/telegramApi.js'
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
import { renderTelegramHtml, stripTelegramHtml } from '../src/telegram/telegramMarkdown.js'
import { handlePermissionReply, handlePermissionCallback, createTelegramPermissionCallbacks, isInteractionTool, summarizePermissionInput } from '../src/telegram/telegramPermissions.js'
import {
  allAnswered,
  answerQuestion,
  autoSubmits,
  buildUpdatedInput,
  commitMultiSelect,
  createSession,
  encodeQ,
  fitCard,
  handleQuestionCallback,
  handleQuestionTextInput,
  parseQ,
  parseQuestions,
  questionKeyboard,
  renderQuestionCard,
  resetQuestionSessions,
  setNote,
  toggleOption,
} from '../src/telegram/telegramQuestions.js'
import {
  _setImagePasteIdSeed,
  buildImageQueueCommand,
  collectAlbumImage,
  pendingAlbumCount,
  resetAlbumBuffers,
} from '../src/telegram/telegramMedia.js'
import {
  handlePlanCallback,
  handlePlanTextInput,
  planResponseFor,
  readPlan,
  resetPlanSessions,
} from '../src/telegram/telegramPlanApproval.js'
import {
  clearStopCard,
  handleInterruptCallback,
  hasStopCard,
  interruptMessage,
  isInterruptCommand,
  performInterrupt,
  resetStopCard,
  showStopCard,
} from '../src/telegram/telegramInterrupt.js'
import {
  isTurnInterruptible,
  publishActiveTurn,
  resetActiveTurn,
} from '../src/utils/activeTurn.js'
import {
  clearCommandQueue,
  enqueue,
  hasCommandsInQueue,
} from '../src/utils/messageQueueManager.js'
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

// ---- permission prompts (inline keyboard flow) ----
// The HostedRouter seam intercepts every Bot API call, so these tests exercise the
// real send/edit/answer path and assert the emitted payloads without any network.
describe('telegram permission prompts', () => {
  interface ApiCall { method: string; params: Record<string, unknown> }
  let calls: ApiCall[]

  beforeEach(() => {
    calls = []
    setHostedRouter({
      getUpdates: async () => [],
      botUsername: async () => 'rayu_test_bot',
      call: async (method, params) => {
        calls.push({ method, params })
        return { message_id: 555 }
      },
    })
    // sendRequest reads linkedChatId from config to know where to send.
    setLinkedChat(4242, 'tester', 'rayu_test_bot')
  })

  afterEach(() => {
    setHostedRouter(null)
  })

  /** Flush the fire-and-forget send inside sendRequest. */
  const settle = () => new Promise(r => setTimeout(r, 0))

  const lastCall = (method: string) => [...calls].reverse().find(c => c.method === method)

  test('sends a prompt with Allow once / Always allow / Deny buttons', async () => {
    const cb = createTelegramPermissionCallbacks('tok')
    cb.sendRequest('req-1', 'Bash', { command: 'rm -rf build' }, 'tu-1', 'Delete the build dir')
    await settle()

    const sent = lastCall('sendMessage')
    expect(sent).toBeDefined()
    expect(sent!.params['chat_id']).toBe(4242)
    expect(sent!.params['parse_mode']).toBe('HTML')

    const text = String(sent!.params['text'])
    expect(text).toContain('🔐 <b>Permission required</b>')
    expect(text).toContain('<b>Bash</b>')
    expect(text).toContain('<code>rm -rf build</code>')
    expect(text).toContain('Delete the build dir')

    const keyboard = (sent!.params['reply_markup'] as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard
    const labels = keyboard.flat().map(b => b.text)
    expect(labels).toEqual(['✅ Allow once', '♾️ Always allow', '⛔ Deny'])
    expect(keyboard.flat().every(b => b.callback_data.startsWith('perm:'))).toBe(true)
  })

  test('tapping Allow once resolves the request with allow and no saved rule', async () => {
    const cb = createTelegramPermissionCallbacks('tok')
    let got: { behavior: string; updatedPermissions?: unknown } | undefined
    cb.onResponse('req-2', r => { got = r })
    cb.sendRequest('req-2', 'FileRead', { file_path: '/tmp/a.txt' }, 'tu-2', 'Read a file')
    await settle()

    const data = ((lastCall('sendMessage')!.params['reply_markup'] as { inline_keyboard: Array<Array<{ callback_data: string }>> })
      .inline_keyboard.flat()[0]!).callback_data
    const handled = await handlePermissionCallback('tok', 4242, 'cbq-1', data)

    expect(handled).toBe(true)
    expect(got?.behavior).toBe('allow')
    expect(got?.updatedPermissions).toBeUndefined()
  })

  test('tapping Always allow saves an allow rule for that tool', async () => {
    const cb = createTelegramPermissionCallbacks('tok')
    let got: { behavior: string; updatedPermissions?: Array<{ rules: Array<{ toolName: string }>; behavior: string }> } | undefined
    cb.onResponse('req-3', r => { got = r as typeof got })
    cb.sendRequest('req-3', 'Bash', { command: 'ls' }, 'tu-3', 'List files')
    await settle()

    const handled = await handlePermissionCallback('tok', 4242, 'cbq-2', 'perm:always:' + currentShortId())
    expect(handled).toBe(true)
    expect(got?.behavior).toBe('allow')
    expect(got?.updatedPermissions?.[0]?.rules[0]?.toolName).toBe('Bash')
    expect(got?.updatedPermissions?.[0]?.behavior).toBe('allow')
  })

  test('tapping Deny resolves with deny', async () => {
    const cb = createTelegramPermissionCallbacks('tok')
    let got: { behavior: string } | undefined
    cb.onResponse('req-4', r => { got = r })
    cb.sendRequest('req-4', 'Bash', { command: 'ls' }, 'tu-4', '')
    await settle()

    await handlePermissionCallback('tok', 4242, 'cbq-3', 'perm:deny:' + currentShortId())
    expect(got?.behavior).toBe('deny')
  })

  test('a decision rewrites the prompt and clears the buttons', async () => {
    const cb = createTelegramPermissionCallbacks('tok')
    cb.onResponse('req-5', () => {})
    cb.sendRequest('req-5', 'Bash', { command: 'ls' }, 'tu-5', '')
    await settle()

    await handlePermissionCallback('tok', 4242, 'cbq-4', 'perm:allow:' + currentShortId())

    const edit = lastCall('editMessageText')
    expect(edit).toBeDefined()
    expect(edit!.params['message_id']).toBe(555)
    expect(String(edit!.params['text'])).toContain('✅ <b>Allowed once</b>')
    // Empty inline_keyboard removes the buttons so a decision can't be re-submitted.
    expect(edit!.params['reply_markup']).toEqual({ inline_keyboard: [] })
  })

  test('answers the callback so the button spinner stops', async () => {
    const cb = createTelegramPermissionCallbacks('tok')
    cb.onResponse('req-6', () => {})
    cb.sendRequest('req-6', 'Bash', { command: 'ls' }, 'tu-6', '')
    await settle()

    await handlePermissionCallback('tok', 4242, 'cbq-5', 'perm:deny:' + currentShortId())
    const answer = lastCall('answerCallbackQuery')
    expect(answer).toBeDefined()
    expect(answer!.params['callback_query_id']).toBe('cbq-5')
    expect(String(answer!.params['text'])).toContain('Denied')
  })

  test('ignores non-permission callback data so the connect wizard still gets it', async () => {
    expect(await handlePermissionCallback('tok', 4242, 'cbq-6', 'cnx:cancel')).toBe(false)
  })

  test('reports stale taps as handled instead of resolving anything', async () => {
    expect(await handlePermissionCallback('tok', 4242, 'cbq-7', 'perm:allow:p9999')).toBe(true)
    const answer = lastCall('answerCallbackQuery')
    expect(String(answer!.params['text'])).toContain('no longer pending')
  })

  test('cancelRequest drops the prompt and later taps do nothing', async () => {
    const cb = createTelegramPermissionCallbacks('tok')
    let calledTimes = 0
    cb.onResponse('req-7', () => { calledTimes++ })
    cb.sendRequest('req-7', 'Bash', { command: 'ls' }, 'tu-7', '')
    await settle()
    const shortId = currentShortId()

    cb.cancelRequest('req-7')
    expect(String(lastCall('editMessageText')!.params['text'])).toContain('Request cancelled')

    await handlePermissionCallback('tok', 4242, 'cbq-8', `perm:allow:${shortId}`)
    expect(calledTimes).toBe(0)
  })

  /** Read the short id back out of the most recent prompt's first button. */
  function currentShortId(): string {
    const keyboard = (lastCall('sendMessage')!.params['reply_markup'] as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard
    return keyboard.flat()[0]!.callback_data.split(':')[2]!
  }
})

describe('summarizePermissionInput', () => {
  test('prefers the shell command', () => {
    expect(summarizePermissionInput('Bash', { command: 'npm test', file_path: '/x' })).toBe('npm test')
  })

  test('falls back to file path, url, then pattern', () => {
    expect(summarizePermissionInput('Edit', { file_path: '/a/b.ts' })).toBe('/a/b.ts')
    expect(summarizePermissionInput('WebFetch', { url: 'https://x.com' })).toBe('https://x.com')
    expect(summarizePermissionInput('Grep', { pattern: 'TODO' })).toBe('TODO')
  })

  test('returns empty string when nothing recognizable is present', () => {
    expect(summarizePermissionInput('Weird', { foo: 1 })).toBe('')
    expect(summarizePermissionInput('Weird', undefined)).toBe('')
  })

  test('collapses whitespace and truncates very long values', () => {
    expect(summarizePermissionInput('Bash', { command: 'a\n  b' })).toBe('a b')
    const out = summarizePermissionInput('Bash', { command: 'x'.repeat(500) })
    expect(out.length).toBeLessThanOrEqual(220)
    expect(out.endsWith('…')).toBe(true)
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

// ---- Markdown → Telegram HTML rendering ----
// The AI emits Markdown; Telegram's HTML parse_mode supports only a small tag
// set. renderTelegramHtml must map Markdown to that set (degrading headings,
// lists, tables, hr) and always emit balanced, escaped, valid HTML.
describe('renderTelegramHtml', () => {
  /** Count open vs close for each supported tag — output must always balance. */
  function tagsBalanced(html: string): boolean {
    const count = (re: RegExp) => (html.match(re) ?? []).length
    // Opens use \b so attributed tags (<code class="language-ts">, <a href=…>) match.
    return (
      count(/<b>/g) === count(/<\/b>/g) &&
      count(/<i>/g) === count(/<\/i>/g) &&
      count(/<s>/g) === count(/<\/s>/g) &&
      count(/<u>/g) === count(/<\/u>/g) &&
      count(/<code\b/g) === count(/<\/code>/g) &&
      count(/<pre\b/g) === count(/<\/pre>/g) &&
      count(/<blockquote\b/g) === count(/<\/blockquote>/g) &&
      count(/<a\b/g) === count(/<\/a>/g)
    )
  }

  test('passes plain text through unchanged', () => {
    expect(renderTelegramHtml('Hello world')).toBe('Hello world')
  })

  test('returns empty string for blank input', () => {
    expect(renderTelegramHtml('')).toBe('')
    expect(renderTelegramHtml('   \n  ')).toBe('')
  })

  test('renders bold and italic', () => {
    expect(renderTelegramHtml('**bold**')).toBe('<b>bold</b>')
    expect(renderTelegramHtml('*italic*')).toBe('<i>italic</i>')
  })

  test('renders nested emphasis', () => {
    expect(renderTelegramHtml('**a _b_**')).toBe('<b>a <i>b</i></b>')
  })

  test('renders inline code and does not format inside it', () => {
    expect(renderTelegramHtml('`x`')).toBe('<code>x</code>')
    expect(renderTelegramHtml('`**not bold**`')).toBe('<code>**not bold**</code>')
  })

  test('renders fenced code with and without a language', () => {
    expect(renderTelegramHtml('```python\nprint(1)\n```')).toContain(
      '<pre><code class="language-python">print(1)</code></pre>',
    )
    expect(renderTelegramHtml('```\nplain\n```')).toContain('<pre>plain</pre>')
  })

  test('renders headings as bold (h1 underlined)', () => {
    expect(renderTelegramHtml('# Title')).toContain('<b><u>Title</u></b>')
    expect(renderTelegramHtml('## Sub')).toContain('<b>Sub</b>')
  })

  test('renders safe links and drops unsafe schemes', () => {
    expect(renderTelegramHtml('[Rayu](https://rayucode.com)')).toBe(
      '<a href="https://rayucode.com">Rayu</a>',
    )
    const unsafe = renderTelegramHtml('[x](javascript:alert(1))')
    expect(unsafe).not.toContain('<a')
    expect(unsafe).toContain('x')
  })

  test('renders bullet and ordered lists', () => {
    const ul = renderTelegramHtml('- a\n- b')
    expect(ul).toContain('• a')
    expect(ul).toContain('• b')
    const ol = renderTelegramHtml('1. first\n2. second')
    expect(ol).toContain('1. first')
    expect(ol).toContain('2. second')
  })

  test('renders blockquotes', () => {
    const q = renderTelegramHtml('> quoted')
    expect(q).toContain('<blockquote>')
    expect(q).toContain('quoted')
    expect(q).toContain('</blockquote>')
  })

  test('renders a horizontal rule as a divider', () => {
    expect(renderTelegramHtml('---')).toContain('──────────')
  })

  test('renders a table as a monospace pre block', () => {
    const table = renderTelegramHtml('| A | B |\n|---|---|\n| 1 | 2 |')
    expect(table).toContain('<pre>')
    expect(table).toContain('A')
    expect(table).toContain('2')
  })

  test('escapes HTML special characters in text', () => {
    expect(renderTelegramHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d')
  })

  test('escapes HTML special characters inside code', () => {
    expect(renderTelegramHtml('`a<b> & c`')).toBe('<code>a&lt;b&gt; &amp; c</code>')
  })

  test('produces balanced tags for partial/streaming markdown', () => {
    // Mid-stream buffers end inside a token — output must still be valid HTML.
    for (const partial of ['**bold', 'text `code', '```js\nconst x =', '# Head', '> quo']) {
      const html = renderTelegramHtml(partial)
      expect(tagsBalanced(html)).toBe(true)
    }
  })

  test('does not throw on messy real-world markdown', () => {
    const md = '## Plan\n\n1. Do **X**\n2. Run `cmd`\n\n```ts\nconst a = 1 < 2\n```\n\n> note\n\n| a | b |\n|--|--|\n| 1 | 2 |'
    const html = renderTelegramHtml(md)
    expect(tagsBalanced(html)).toBe(true)
    expect(html).toContain('<b>X</b>')
    expect(html).toContain('<code>cmd</code>')
    expect(html).toContain('const a = 1 &lt; 2')
  })
})

describe('stripTelegramHtml', () => {
  test('removes tags and decodes entities', () => {
    expect(stripTelegramHtml('<b>x</b>')).toBe('x')
    expect(stripTelegramHtml('<a href="https://x.com">link</a>')).toBe('link')
    expect(stripTelegramHtml('&lt;div&gt; &amp; &quot;q&quot;')).toBe('<div> & "q"')
  })

  test('round-trips rendered markdown back to readable text', () => {
    const html = renderTelegramHtml('**bold** and `code`')
    expect(stripTelegramHtml(html)).toBe('bold and code')
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

// ---------------------------------------------------------------------------
// AskUserQuestion over Telegram
// ---------------------------------------------------------------------------

// The answers are delivered back through `updatedInput.answers` (the same
// contract the terminal dialog uses), so these tests assert the exact object a
// tap sequence produces — an empty `answers` map is the bug this flow fixes.
describe('question callback data codec', () => {
  test('round-trips an option tap', () => {
    const data = encodeQ('o', 'k1', 2, 3)
    expect(data).toBe('q:o:k1:2:3')
    expect(parseQ(data)).toEqual({ action: 'o', sid: 'k1', qIndex: 2, optIndex: 3 })
  })

  test('ignores other namespaces', () => {
    expect(parseQ('perm:allow:p1')).toBeUndefined()
    expect(parseQ('cnx:p:openai')).toBeUndefined()
    expect(parseQ('mdl:mi:3')).toBeUndefined()
  })

  test('rejects unknown actions and malformed indices', () => {
    expect(parseQ('q:zz:k1')).toBeUndefined()
    expect(parseQ('q:o:k1:abc')).toBeUndefined()
    expect(parseQ('q:o')).toBeUndefined()
  })

  test('stays well under the 64-byte callback_data cap', () => {
    const session = createSession({
      requestId: 'r',
      chatId: 1,
      token: 't',
      input: {
        questions: [
          {
            question: 'A very long question '.repeat(20),
            header: 'Header',
            options: [
              { label: 'Option one with a long label', description: 'x'.repeat(300) },
              { label: 'Option two', description: 'y' },
            ],
          },
        ],
      },
    })
    for (const row of questionKeyboard(session)) {
      for (const button of row) {
        expect(Buffer.byteLength(button.callback_data, 'utf8')).toBeLessThanOrEqual(64)
      }
    }
  })
})

describe('question session state machine', () => {
  const twoQuestions = {
    questions: [
      {
        question: 'Which database?',
        header: 'DB',
        options: [
          { label: 'Postgres', description: 'Relational', preview: 'CREATE TABLE …' },
          { label: 'SQLite', description: 'Embedded' },
        ],
      },
      {
        question: 'Which extras?',
        header: 'Extras',
        multiSelect: true,
        options: [
          { label: 'Auth', description: 'Login' },
          { label: 'Billing', description: 'Payments' },
          { label: 'Search', description: 'Full text' },
        ],
      },
    ],
    metadata: { source: 'test' },
  }

  test('parseQuestions survives malformed input', () => {
    expect(parseQuestions(undefined)).toEqual([])
    expect(parseQuestions({ questions: 'nope' })).toEqual([])
    expect(parseQuestions({ questions: [null, 42, { question: '' }] })).toEqual([])
    const ok = parseQuestions({ questions: [{ question: 'Q', options: [{ label: 'A' }, 'bad'] }] })
    expect(ok).toHaveLength(1)
    expect(ok[0]!.options).toEqual([{ label: 'A' }])
  })

  test('builds the updatedInput the tool expects', () => {
    const session = createSession({
      requestId: 'r1',
      chatId: 1,
      token: 't',
      input: twoQuestions as unknown as Record<string, unknown>,
    })

    // Q1: pick an option that carries a preview, and attach a note.
    answerQuestion(session, 0, 'Postgres')
    setNote(session, 0, '  needs pgvector  ')
    expect(session.index).toBe(1)

    // Q2: multi-select two options, then commit.
    toggleOption(session, 1, 0)
    toggleOption(session, 1, 2)
    toggleOption(session, 1, 2) // toggling twice clears it
    toggleOption(session, 1, 1)
    expect(commitMultiSelect(session, 1)).toBe(true)

    expect(allAnswered(session)).toBe(true)
    expect(buildUpdatedInput(session)).toEqual({
      ...twoQuestions,
      answers: {
        'Which database?': 'Postgres',
        'Which extras?': 'Auth, Billing',
      },
      annotations: {
        'Which database?': { preview: 'CREATE TABLE …', notes: 'needs pgvector' },
      },
    })
  })

  test('commit is refused while nothing is selected', () => {
    const session = createSession({
      requestId: 'r2',
      chatId: 1,
      token: 't',
      input: twoQuestions as unknown as Record<string, unknown>,
    })
    expect(commitMultiSelect(session, 1)).toBe(false)
  })

  test('a single single-select question submits without a review step', () => {
    const one = createSession({
      requestId: 'r3',
      chatId: 1,
      token: 't',
      input: { questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
    })
    expect(autoSubmits(one)).toBe(true)

    const many = createSession({
      requestId: 'r4',
      chatId: 1,
      token: 't',
      input: twoQuestions as unknown as Record<string, unknown>,
    })
    expect(autoSubmits(many)).toBe(false)
  })
})

describe('question card rendering', () => {
  const session = () =>
    createSession({
      requestId: 'rr',
      chatId: 1,
      token: 't',
      input: {
        questions: [
          {
            question: 'Which database?',
            header: 'DB',
            options: [
              { label: 'Postgres', description: 'Relational', preview: 'CREATE TABLE x;' },
              { label: 'SQLite', description: 'Embedded' },
            ],
          },
        ],
      },
    })

  test('shows the question, options and previews', () => {
    const text = renderQuestionCard(session())
    expect(text).toContain('<b>Which database?</b>')
    expect(text).toContain('<b>Postgres</b>')
    expect(text).toContain('<i>Relational</i>')
    expect(text).toContain('<pre>CREATE TABLE x;</pre>')
  })

  test('escapes untrusted question text', () => {
    const hostile = createSession({
      requestId: 'rh',
      chatId: 1,
      token: 't',
      input: {
        questions: [{ question: 'Use <script> & tags?', options: [{ label: '<b>bold</b>' }] }],
      },
    })
    const text = renderQuestionCard(hostile)
    expect(text).toContain('&lt;script&gt; &amp; tags?')
    expect(text).not.toContain('<script>')
  })

  test('multi-select renders checkboxes and a Done button', () => {
    const multi = createSession({
      requestId: 'rm',
      chatId: 1,
      token: 't',
      input: {
        questions: [
          {
            question: 'Pick features',
            multiSelect: true,
            options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }],
          },
        ],
      },
    })
    toggleOption(multi, 0, 1)
    const text = renderQuestionCard(multi)
    expect((text.match(/☐/g) ?? []).length).toBe(3)
    expect((text.match(/☑/g) ?? []).length).toBe(1)
    const labels = questionKeyboard(multi).flat().map(b => b.text)
    expect(labels).toContain('✅ Done')
    expect(labels.some(l => l.startsWith('☑'))).toBe(true)
  })

  test('clamps an oversized card to Telegram’s limit', () => {
    const huge = createSession({
      requestId: 'rg',
      chatId: 1,
      token: 't',
      input: {
        questions: [
          {
            question: 'Q'.repeat(400),
            options: [
              { label: 'A', description: 'd'.repeat(3000), preview: 'p'.repeat(3000) },
              { label: 'B', description: 'e'.repeat(3000), preview: 'q'.repeat(3000) },
            ],
          },
        ],
      },
    })
    expect(fitCard(huge).length).toBeLessThanOrEqual(4096)
  })
})

// End-to-end through the HostedRouter seam: real send/edit/answer payloads, no network.
describe('question flow over the bridge', () => {
  interface ApiCall { method: string; params: Record<string, unknown> }
  let calls: ApiCall[]
  let nextMessageId: number

  beforeEach(() => {
    calls = []
    nextMessageId = 900
    resetQuestionSessions()
    setHostedRouter({
      getUpdates: async () => [],
      botUsername: async () => 'rayu_test_bot',
      call: async (method, params) => {
        calls.push({ method, params })
        return { message_id: ++nextMessageId }
      },
    })
    setLinkedChat(4242, 'tester', 'rayu_test_bot')
  })

  afterEach(() => {
    setHostedRouter(null)
    resetQuestionSessions()
  })

  const settle = () => new Promise(r => setTimeout(r, 0))
  const lastCall = (method: string) => [...calls].reverse().find(c => c.method === method)
  const keyboardOf = (call: ApiCall) =>
    (call.params['reply_markup'] as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> })
      .inline_keyboard

  const singleQuestion = {
    questions: [
      {
        question: 'Which database should we use?',
        header: 'DB',
        options: [
          { label: 'Postgres', description: 'Relational' },
          { label: 'SQLite', description: 'Embedded' },
        ],
      },
    ],
  }

  test('renders the real question instead of a bare permission card', async () => {
    const cb = createTelegramPermissionCallbacks('tok')
    cb.sendRequest('q-1', 'AskUserQuestion', singleQuestion, 'tu-1', 'Answer questions?')
    await settle()

    const sent = lastCall('sendMessage')!
    const text = String(sent.params['text'])
    expect(text).toContain('Which database should we use?')
    expect(text).toContain('Postgres')
    expect(text).not.toContain('🔐 <b>Permission required</b>')

    const labels = keyboardOf(sent).flat().map(b => b.text)
    expect(labels.some(l => l.includes('Postgres'))).toBe(true)
    expect(labels).toContain('⛔ Cancel')
    // Never offer a persistent rule for a form.
    expect(labels.some(l => l.includes('Always'))).toBe(false)
  })

  test('tapping an option returns the answers in updatedInput', async () => {
    const cb = createTelegramPermissionCallbacks('tok')
    let got: { behavior: string; updatedInput?: Record<string, unknown> } | undefined
    cb.onResponse('q-2', r => { got = r })
    cb.sendRequest('q-2', 'AskUserQuestion', singleQuestion, 'tu-2', 'Answer questions?')
    await settle()

    const data = keyboardOf(lastCall('sendMessage')!).flat()[0]!.callback_data
    expect(await handleQuestionCallback('tok', 4242, 'cbq-1', data)).toBe(true)

    expect(got?.behavior).toBe('allow')
    expect(got?.updatedInput?.['answers']).toEqual({
      'Which database should we use?': 'Postgres',
    })
    // The card is closed and the buttons removed.
    const edit = lastCall('editMessageText')!
    expect(String(edit.params['text'])).toContain('Answers sent')
    expect((edit.params['reply_markup'] as { inline_keyboard: unknown[] }).inline_keyboard).toEqual([])
  })

  test('multi-question interview walks to a review card before submitting', async () => {
    const cb = createTelegramPermissionCallbacks('tok')
    let got: { behavior: string; updatedInput?: Record<string, unknown> } | undefined
    cb.onResponse('q-3', r => { got = r })
    cb.sendRequest(
      'q-3',
      'AskUserQuestion',
      {
        questions: [
          { question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
          {
            question: 'Which extras?',
            multiSelect: true,
            options: [{ label: 'Auth' }, { label: 'Billing' }],
          },
        ],
      },
      'tu-3',
      'Answer questions?',
    )
    await settle()

    const sid = keyboardOf(lastCall('sendMessage')!).flat()[0]!.callback_data.split(':')[2]!
    await handleQuestionCallback('tok', 4242, 'c1', `q:o:${sid}:0:0`) // Postgres
    expect(got).toBeUndefined() // still interviewing

    await handleQuestionCallback('tok', 4242, 'c2', `q:o:${sid}:1:0`) // toggle Auth
    await handleQuestionCallback('tok', 4242, 'c3', `q:d:${sid}:1`) // Done
    expect(got).toBeUndefined()

    const review = String(lastCall('editMessageText')!.params['text'])
    expect(review).toContain('Review your answers')
    expect(keyboardOf(lastCall('editMessageText')!).flat().map(b => b.text)).toContain('✅ Submit')

    await handleQuestionCallback('tok', 4242, 'c4', `q:s:${sid}`)
    expect(got?.updatedInput?.['answers']).toEqual({
      'Which database?': 'Postgres',
      'Which extras?': 'Auth',
    })
  })

  test('“Other” opens a force_reply and the typed answer is consumed', async () => {
    const cb = createTelegramPermissionCallbacks('tok')
    let got: { behavior: string; updatedInput?: Record<string, unknown> } | undefined
    cb.onResponse('q-4', r => { got = r })
    cb.sendRequest('q-4', 'AskUserQuestion', singleQuestion, 'tu-4', 'Answer questions?')
    await settle()

    const sid = keyboardOf(lastCall('sendMessage')!).flat()[0]!.callback_data.split(':')[2]!
    await handleQuestionCallback('tok', 4242, 'c1', `q:x:${sid}:0`)

    const prompt = lastCall('sendMessage')!
    expect((prompt.params['reply_markup'] as { force_reply?: boolean }).force_reply).toBe(true)
    const promptId = 902 // second sendMessage of this test

    const consumed = await handleQuestionTextInput(4242, 'DuckDB please', promptId)
    expect(consumed).toBe(true)
    expect(got?.updatedInput?.['answers']).toEqual({
      'Which database should we use?': 'DuckDB please',
    })
  })

  test('a note is attached as an annotation', async () => {
    const cb = createTelegramPermissionCallbacks('tok')
    let got: { updatedInput?: Record<string, unknown> } | undefined
    cb.onResponse('q-5', r => { got = r })
    cb.sendRequest('q-5', 'AskUserQuestion', singleQuestion, 'tu-5', 'Answer questions?')
    await settle()

    const sid = keyboardOf(lastCall('sendMessage')!).flat()[0]!.callback_data.split(':')[2]!
    await handleQuestionCallback('tok', 4242, 'c1', `q:n:${sid}:0`)
    await handleQuestionTextInput(4242, 'must run on ARM', 902)
    await handleQuestionCallback('tok', 4242, 'c2', `q:o:${sid}:0:1`) // SQLite

    expect(got?.updatedInput?.['annotations']).toEqual({
      'Which database should we use?': { notes: 'must run on ARM' },
    })
  })

  test('unrelated text is left alone when nothing is awaiting input', async () => {
    expect(await handleQuestionTextInput(4242, 'what is the weather', undefined)).toBe(false)
  })

  // force_reply is not dependable (desktop clients, or the prompt no longer
  // being the newest message, drop the reply association), so typing must work
  // on its own — otherwise the answer leaks to the model as a new turn.
  test('a plain message with no reply association still answers the question', async () => {
    const cb = createTelegramPermissionCallbacks('tok')
    let got: { updatedInput?: Record<string, unknown> } | undefined
    cb.onResponse('q-9', r => { got = r })
    cb.sendRequest('q-9', 'AskUserQuestion', singleQuestion, 'tu-9', 'Answer questions?')
    await settle()

    // No "Other" tap, no reply_to_message — just a message.
    expect(await handleQuestionTextInput(4242, 'MySQL actually', undefined)).toBe(true)
    expect(got?.updatedInput?.['answers']).toEqual({
      'Which database should we use?': 'MySQL actually',
    })
  })

  test('a reply pointing at the card (not the prompt) is still accepted', async () => {
    const cb = createTelegramPermissionCallbacks('tok')
    let got: { updatedInput?: Record<string, unknown> } | undefined
    cb.onResponse('q-10', r => { got = r })
    cb.sendRequest('q-10', 'AskUserQuestion', singleQuestion, 'tu-10', 'Answer questions?')
    await settle()

    const sid = keyboardOf(lastCall('sendMessage')!).flat()[0]!.callback_data.split(':')[2]!
    await handleQuestionCallback('tok', 4242, 'c1', `q:x:${sid}:0`)
    // 4242 is not a message id we ever sent — simulates a mismatched reply target.
    expect(await handleQuestionTextInput(4242, 'Cassandra', 123456)).toBe(true)
    expect(got?.updatedInput?.['answers']).toEqual({
      'Which database should we use?': 'Cassandra',
    })
  })

  test('slash commands are not swallowed as an answer', async () => {
    const cb = createTelegramPermissionCallbacks('tok')
    cb.sendRequest('q-11', 'AskUserQuestion', singleQuestion, 'tu-11', 'Answer questions?')
    await settle()

    // Greedy capture must yield to commands so /interrupt still works.
    expect(await handleQuestionTextInput(4242, '/interrupt', undefined)).toBe(false)
    // But an explicit "Other" reply takes the text verbatim, slash and all.
    const sid = keyboardOf(lastCall('sendMessage')!).flat()[0]!.callback_data.split(':')[2]!
    await handleQuestionCallback('tok', 4242, 'c1', `q:x:${sid}:0`)
    expect(await handleQuestionTextInput(4242, '/usr/local/pgsql', undefined)).toBe(true)
  })

  test('Cancel declines the tool', async () => {
    const cb = createTelegramPermissionCallbacks('tok')
    let got: { behavior: string; message?: string } | undefined
    cb.onResponse('q-6', r => { got = r })
    cb.sendRequest('q-6', 'AskUserQuestion', singleQuestion, 'tu-6', 'Answer questions?')
    await settle()

    const sid = keyboardOf(lastCall('sendMessage')!).flat()[0]!.callback_data.split(':')[2]!
    await handleQuestionCallback('tok', 4242, 'c1', `q:c:${sid}`)

    expect(got?.behavior).toBe('deny')
    expect(got?.message).toContain('declined')
  })

  test('a stale card reports itself instead of resolving anything', async () => {
    expect(await handleQuestionCallback('tok', 4242, 'c1', 'q:o:k999:0:0')).toBe(true)
    const answered = lastCall('answerCallbackQuery')!
    expect(String(answered.params['text'])).toContain('no longer active')
  })

  test('cancelRequest closes the card without answering the tool', async () => {
    const cb = createTelegramPermissionCallbacks('tok')
    let called = false
    cb.onResponse('q-7', () => { called = true })
    cb.sendRequest('q-7', 'AskUserQuestion', singleQuestion, 'tu-7', 'Answer questions?')
    await settle()

    cb.cancelRequest('q-7')
    await settle()

    expect(called).toBe(false)
    expect(String(lastCall('editMessageText')!.params['text'])).toContain('Answered in the terminal')
    // The session is gone, so a later tap can't revive it.
    expect(await handleQuestionTextInput(4242, 'late answer', undefined)).toBe(false)
  })

  test('an empty question list falls back to the generic permission card', async () => {
    const cb = createTelegramPermissionCallbacks('tok')
    cb.sendRequest('q-8', 'AskUserQuestion', { questions: [] }, 'tu-8', 'Answer questions?')
    await settle()

    const text = String(lastCall('sendMessage')!.params['text'])
    expect(text).toContain('🔐 <b>Permission required</b>')
    // Still no "Always allow" — a persisted rule would auto-submit empty answers.
    const labels = keyboardOf(lastCall('sendMessage')!).flat().map(b => b.text)
    expect(labels).toEqual(['✅ Allow once', '⛔ Deny'])
  })
})

// ---------------------------------------------------------------------------
// Interaction-tool hardening
// ---------------------------------------------------------------------------

describe('interaction tool guard', () => {
  test('classifies the form-like tools', () => {
    expect(isInteractionTool('AskUserQuestion')).toBe(true)
    expect(isInteractionTool('ExitPlanMode')).toBe(true)
    expect(isInteractionTool('ReviewArtifact')).toBe(true)
    expect(isInteractionTool('Bash')).toBe(false)
  })
})

describe('handlePermissionReply resolves one request at a time', () => {
  let calls: Array<{ method: string; params: Record<string, unknown> }>

  beforeEach(() => {
    calls = []
    setHostedRouter({
      getUpdates: async () => [],
      botUsername: async () => 'rayu_test_bot',
      call: async (method, params) => {
        calls.push({ method, params })
        return { message_id: 777 }
      },
    })
    setLinkedChat(4242, 'tester', 'rayu_test_bot')
    // Earlier suites leave records that were never tapped. "Oldest" is global
    // state, so drain them first (with the router installed, so no network).
    while (handlePermissionReply('n')) {
      /* drain */
    }
    calls = []
  })

  afterEach(() => {
    setHostedRouter(null)
  })

  test('a typed "y" approves only the oldest pending request', async () => {
    const cb = createTelegramPermissionCallbacks('tok')
    const seen: string[] = []
    cb.onResponse('t-1', () => seen.push('first'))
    cb.sendRequest('t-1', 'Bash', { command: 'ls' }, 'tu-1', '')
    cb.onResponse('t-2', () => seen.push('second'))
    cb.sendRequest('t-2', 'Bash', { command: 'pwd' }, 'tu-2', '')
    await new Promise(r => setTimeout(r, 0))

    expect(handlePermissionReply('y')).toBe(true)
    expect(seen).toEqual(['first'])

    expect(handlePermissionReply('y')).toBe(true)
    expect(seen).toEqual(['first', 'second'])

    expect(handlePermissionReply('y')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Telegram → terminal image relay
// ---------------------------------------------------------------------------

describe('buildImageQueueCommand', () => {
  beforeEach(() => {
    _setImagePasteIdSeed(1000)
  })

  test('assigns unique non-zero ids and references them in the text', () => {
    const cmd = buildImageQueueCommand('look at these', [
      { base64: 'AAA', mediaType: 'image/jpeg', width: 800, height: 600 },
      { base64: 'BBB', mediaType: 'image/png', width: 100, height: 50 },
    ])!

    const ids = Object.keys(cmd.pastedContents!).map(Number)
    expect(ids).toEqual([1001, 1002])
    expect(ids.every(id => id !== 0)).toBe(true)
    expect(cmd.value).toBe('look at these\n[Image #1001] [Image #1002]')
    expect(cmd.mode).toBe('prompt')
  })

  test('uses the ImageDimensions shape the renderer and model expect', () => {
    const cmd = buildImageQueueCommand('', [
      { base64: 'AAA', mediaType: 'image/jpeg', width: 800, height: 600 },
    ])!
    expect(cmd.pastedContents![1001]!.dimensions).toEqual({
      originalWidth: 800,
      originalHeight: 600,
    })
    expect(String(cmd.value).startsWith('Analyze this image')).toBe(true)
  })

  test('keeps the filename for documents and skips empty payloads', () => {
    const cmd = buildImageQueueCommand('', [
      { base64: 'AAA', mediaType: 'image/png', filename: 'diagram.png' },
      { base64: '', mediaType: 'image/png' },
    ])!
    expect(Object.keys(cmd.pastedContents!)).toHaveLength(1)
    expect(cmd.pastedContents![1001]!.filename).toBe('diagram.png')
    expect(cmd.pastedContents![1001]!.dimensions).toBeUndefined()
    expect(buildImageQueueCommand('', [])).toBeUndefined()
  })
})

describe('album buffering', () => {
  beforeEach(() => {
    resetAlbumBuffers()
    _setImagePasteIdSeed(2000)
  })

  afterEach(() => {
    resetAlbumBuffers()
  })

  test('an album becomes one turn carrying every image and the single caption', async () => {
    const flushed: Array<{ value: string | unknown; pastedContents?: Record<number, unknown> }> = []
    const image = (n: string) => ({ base64: n, mediaType: 'image/jpeg', width: 10, height: 10 })

    collectAlbumImage({ groupId: 'g1', caption: 'review these', image: image('A'), flushMs: 5, onFlush: c => flushed.push(c) })
    collectAlbumImage({ groupId: 'g1', caption: '', image: image('B'), flushMs: 5, onFlush: c => flushed.push(c) })
    collectAlbumImage({ groupId: 'g1', caption: '', image: image('C'), flushMs: 5, onFlush: c => flushed.push(c) })
    expect(pendingAlbumCount()).toBe(1)

    await new Promise(r => setTimeout(r, 30))

    expect(flushed).toHaveLength(1)
    expect(Object.keys(flushed[0]!.pastedContents!)).toHaveLength(3)
    expect(String(flushed[0]!.value)).toBe('review these\n[Image #2001] [Image #2002] [Image #2003]')
    expect(pendingAlbumCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ExitPlanMode card
// ---------------------------------------------------------------------------

describe('plan approval card', () => {
  interface ApiCall { method: string; params: Record<string, unknown> }
  let calls: ApiCall[]
  let nextMessageId: number

  beforeEach(() => {
    calls = []
    nextMessageId = 500
    resetPlanSessions()
    setHostedRouter({
      getUpdates: async () => [],
      botUsername: async () => 'rayu_test_bot',
      call: async (method, params) => {
        calls.push({ method, params })
        return { message_id: ++nextMessageId }
      },
    })
    setLinkedChat(4242, 'tester', 'rayu_test_bot')
  })

  afterEach(() => {
    setHostedRouter(null)
    resetPlanSessions()
  })

  const settle = () => new Promise(r => setTimeout(r, 0))
  const lastCall = (method: string) => [...calls].reverse().find(c => c.method === method)

  test('reads the plan defensively', () => {
    expect(readPlan({ plan: '## Steps' })).toBe('## Steps')
    expect(readPlan({})).toBe('')
    expect(readPlan(undefined)).toBe('')
  })

  test('renders the plan as Telegram HTML with three choices', async () => {
    const cb = createTelegramPermissionCallbacks('tok')
    cb.sendRequest('p-1', 'ExitPlanMode', { plan: '## Steps\n\n- **one**\n- two' }, 'tu-1', 'Approve plan?')
    await settle()

    const sent = lastCall('sendMessage')!
    const text = String(sent.params['text'])
    expect(text).toContain('Plan ready for review')
    expect(text).toContain('<b>Steps</b>')
    expect(text).toContain('<b>one</b>')

    const labels = (sent.params['reply_markup'] as { inline_keyboard: Array<Array<{ text: string }>> })
      .inline_keyboard.flat().map(b => b.text)
    expect(labels).toEqual(['✅ Approve', '⚡ Approve + auto-accept edits', '✏️ Keep planning'])
  })

  test('approve + auto-accept edits sets the session permission mode', () => {
    expect(planResponseFor('a')).toEqual({ behavior: 'allow' })
    expect(planResponseFor('e')).toEqual({
      behavior: 'allow',
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    })
  })

  test('keep planning returns the typed feedback as the denial message', async () => {
    const cb = createTelegramPermissionCallbacks('tok')
    let got: { behavior: string; message?: string } | undefined
    cb.onResponse('p-2', r => { got = r })
    cb.sendRequest('p-2', 'ExitPlanMode', { plan: 'do the thing' }, 'tu-2', 'Approve plan?')
    await settle()

    const sid = String(
      (lastCall('sendMessage')!.params['reply_markup'] as { inline_keyboard: Array<Array<{ callback_data: string }>> })
        .inline_keyboard.flat()[0]!.callback_data,
    ).split(':')[2]
    await handlePlanCallback('tok', 4242, 'c1', `pl:k:${sid}`)

    const prompt = lastCall('sendMessage')!
    expect((prompt.params['reply_markup'] as { force_reply?: boolean }).force_reply).toBe(true)

    expect(await handlePlanTextInput(4242, 'split step 2 in half', 502)).toBe(true)
    expect(got?.behavior).toBe('deny')
    expect(got?.message).toBe('split step 2 in half')
  })

  test('a plan-less request falls back to the generic permission card', async () => {
    const cb = createTelegramPermissionCallbacks('tok')
    cb.sendRequest('p-3', 'ExitPlanMode', {}, 'tu-3', 'Approve plan?')
    await settle()
    expect(String(lastCall('sendMessage')!.params['text'])).toContain('🔐 <b>Permission required</b>')
  })
})

// ---------------------------------------------------------------------------
// force_reply payload
// ---------------------------------------------------------------------------

describe('buildForceReplyBody', () => {
  test('asks Telegram to open the reply box', () => {
    const body = buildForceReplyBody(42, 'Answer this', 'HTML', 'Type your answer')
    expect(body['chat_id']).toBe(42)
    expect(body['parse_mode']).toBe('HTML')
    expect(body['reply_markup']).toEqual({
      force_reply: true,
      input_field_placeholder: 'Type your answer',
    })
  })

  test('clamps the text and the placeholder', () => {
    const body = buildForceReplyBody(1, 'x'.repeat(5000), undefined, 'p'.repeat(200))
    expect(String(body['text']).length).toBe(4096)
    expect(body['parse_mode']).toBeUndefined()
    expect(
      (body['reply_markup'] as { input_field_placeholder: string }).input_field_placeholder.length,
    ).toBe(64)
  })
})

// ---------------------------------------------------------------------------
// Stop the AI from Telegram
// ---------------------------------------------------------------------------

describe('telegram interrupt', () => {
  interface ApiCall { method: string; params: Record<string, unknown> }
  let calls: ApiCall[]

  beforeEach(() => {
    calls = []
    resetActiveTurn()
    resetStopCard()
    clearCommandQueue()
    setHostedRouter({
      getUpdates: async () => [],
      botUsername: async () => 'rayu_test_bot',
      call: async (method, params) => {
        calls.push({ method, params })
        return { message_id: 321 }
      },
    })
    setLinkedChat(4242, 'tester', 'rayu_test_bot')
  })

  afterEach(() => {
    setHostedRouter(null)
    resetActiveTurn()
    resetStopCard()
    clearCommandQueue()
  })

  const lastCall = (method: string) => [...calls].reverse().find(c => c.method === method)

  test('recognises the interrupt commands but not /stop (that unlinks)', () => {
    expect(isInterruptCommand('/interrupt')).toBe(true)
    expect(isInterruptCommand('/cancel')).toBe(true)
    expect(isInterruptCommand('/esc')).toBe(true)
    expect(isInterruptCommand('/abort')).toBe(true)
    // /stop is consumed by the hosted backend as a disconnect command.
    expect(isInterruptCommand('/stop')).toBe(false)
    expect(isInterruptCommand('/model')).toBe(false)
  })

  test('aborts the running turn with a remote-interrupt reason', () => {
    const controller = new AbortController()
    publishActiveTurn(controller)
    expect(isTurnInterruptible()).toBe(true)

    expect(performInterrupt()).toBe('stopped')
    expect(controller.signal.aborted).toBe(true)
    // 'interrupt', not 'user-cancel': the REPL rewinds the conversation and
    // restores the prompt locally on 'user-cancel', which must not happen for a
    // turn that came from Telegram.
    expect(controller.signal.reason).toBe('interrupt')
    expect(isTurnInterruptible()).toBe(false)
  })

  test('a second interrupt reports idle instead of pretending', () => {
    const controller = new AbortController()
    publishActiveTurn(controller)
    expect(performInterrupt()).toBe('stopped')
    expect(performInterrupt()).toBe('idle')
    expect(interruptMessage('idle')).toContain('Nothing is running')
  })

  test('with no turn running it drops queued messages instead', () => {
    enqueue({ value: 'do a thing', mode: 'prompt' })
    expect(performInterrupt()).toBe('queue-cleared')
    expect(hasCommandsInQueue()).toBe(false)
  })

  test('the stop card carries a single ⛔ Stop button and is reused', async () => {
    await showStopCard('tok', 4242)
    const sent = lastCall('sendMessage')!
    const keyboard = (sent.params['reply_markup'] as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
    }).inline_keyboard
    expect(keyboard.flat().map(b => b.text)).toEqual(['⛔ Stop'])
    expect(keyboard.flat()[0]!.callback_data).toBe('int:stop')

    // A second turn must not stack another button in the chat.
    const before = calls.filter(c => c.method === 'sendMessage').length
    await showStopCard('tok', 4242)
    expect(calls.filter(c => c.method === 'sendMessage').length).toBe(before)
  })

  test('tapping Stop aborts the turn and clears the buttons', async () => {
    const controller = new AbortController()
    publishActiveTurn(controller)
    await showStopCard('tok', 4242)

    const handled = await handleInterruptCallback('tok', 4242, 'cbq-1', 'int:stop')
    expect(handled).toBe(true)
    expect(controller.signal.aborted).toBe(true)

    const edit = lastCall('editMessageText')!
    expect(String(edit.params['text'])).toContain('Stopped')
    expect((edit.params['reply_markup'] as { inline_keyboard: unknown[] }).inline_keyboard).toEqual([])
    expect(hasStopCard()).toBe(false)
  })

  test('ignores callbacks from other namespaces', async () => {
    expect(await handleInterruptCallback('tok', 4242, 'cbq-2', 'perm:allow:p1')).toBe(false)
    expect(await handleInterruptCallback('tok', 4242, 'cbq-3', 'q:o:k1:0:0')).toBe(false)
  })

  test('clearStopCard retires the card after a normal turn', async () => {
    await showStopCard('tok', 4242)
    await clearStopCard()
    expect(hasStopCard()).toBe(false)
    expect(String(lastCall('editMessageText')!.params['text'])).toContain('Done')
  })
})

// ---------------------------------------------------------------------------
// Pairing security
// ---------------------------------------------------------------------------

// The pending token is the only gate between a stranger's chat and control of
// this CLI (a linked chat can approve tool use, including Bash), and the bot
// accepts messages from anyone who can find it.
describe('pairing token hardening', () => {
  let tmp: string
  const origConfigDir = process.env.RAYU_CONFIG_DIR
  const clearHomeCache = () => {
    const cache = (getRayuConfigHomeDir as unknown as { cache?: Map<unknown, unknown> }).cache
    cache?.clear?.()
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'rayu-pair-'))
    process.env.RAYU_CONFIG_DIR = tmp
    clearHomeCache()
    writeTelegramConfig({})
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    if (origConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
    else process.env.RAYU_CONFIG_DIR = origConfigDir
    clearHomeCache()
  })

  test('a wrong token never links the chat', () => {
    setPendingToken('correct-token', 60_000)
    expect(consumePendingToken('wrong-token', 111, 'attacker')).toBeNull()
    expect(readTelegramConfig().linkedChatId).toBeUndefined()
  })

  test('the token is burnt after repeated wrong guesses', () => {
    setPendingToken('correct-token', 60_000)
    for (let i = 0; i < 5; i++) {
      expect(consumePendingToken(`guess-${i}`, 111, 'attacker')).toBeNull()
    }
    // Pending token is gone, so even the RIGHT token no longer links.
    expect(readTelegramConfig().pendingToken).toBeUndefined()
    expect(consumePendingToken('correct-token', 222, 'owner')).toBeNull()
  })

  test('a successful pair resets the attempt counter', () => {
    setPendingToken('tok-a', 60_000)
    expect(consumePendingToken('nope', 111, 'x')).toBeNull()
    expect(consumePendingToken('tok-a', 222, 'owner')).not.toBeNull()
    expect(readTelegramConfig().linkedChatId).toBe(222)

    // Fresh budget: four misses in a row must not burn the next token.
    setPendingToken('tok-b', 60_000)
    for (let i = 0; i < 4; i++) consumePendingToken('nope', 111, 'x')
    expect(readTelegramConfig().pendingToken?.token).toBe('tok-b')
  })

  test('an expired token cannot be used', () => {
    setPendingToken('tok-c', -1)
    expect(consumePendingToken('tok-c', 111, 'owner')).toBeNull()
  })

  test('the config file is not world-readable', () => {
    writeTelegramConfig({ linkedChatId: 5 })
    const mode = statSync(join(tmp, 'telegram.json')).mode & 0o777
    expect(mode & 0o077).toBe(0)
  })
})
