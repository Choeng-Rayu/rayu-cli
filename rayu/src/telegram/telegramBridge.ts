/** In-process Telegram bridge: relays chat messages <-> REPL with no middle server. */

import { hostname } from 'os'
import {
  formatFileChangeReview,
  formatMessage,
  isFileChangeReviewMessage,
  type ToolLabeler,
  type WrappedMessage,
} from './formatActivity.js'
import {
  consumePendingToken,
  readTelegramConfig,
  unlink,
} from './telegramConfig.js'
import {
  answerCallbackQuery,
  getUpdates,
  sendChatAction,
  sendMessage,
  sendPhoto,
  setMyCommands,
  type TelegramUpdate,
} from './telegramApi.js'
import {
  createTelegramPermissionCallbacks,
  handlePermissionReply,
} from './telegramPermissions.js'
import {
  handleCallbackQuery,
  handleConnectCommand,
  handleConnectTextInput,
  handleModelCommand,
  handleProviderCommand,
  isConnectSessionActive,
} from './telegramConnect.js'
import { StreamingMirror } from './streamingMirror.js'
import type { BridgePermissionCallbacks } from '../bridge/bridgePermissionCallbacks.js'
import { enqueue } from '../utils/messageQueueManager.js'

export interface TelegramBridgeOptions {
  token: string
  toolLabeler?: ToolLabeler
}

export interface TelegramBridgeHandle {
  /** Mirror complete REPL messages (user/assistant) to the linked chat. */
  pushActivity: (messages: WrappedMessage[]) => void
  /** Called when a new assistant turn begins streaming. */
  startTurn: () => void
  /** Called with each streamed text token delta. */
  onTextDelta: (delta: string) => void
  /** Called with each streamed thinking token delta. */
  onThinkingDelta: (delta: string) => void
  /** Called when the streaming turn is complete. Finalizes the live message. */
  endTurn: () => Promise<void>
  /** BridgePermissionCallbacks to inject into AppState for permission prompts. */
  permissionCallbacks: BridgePermissionCallbacks
  stop: () => void
}

function linkedChatId(): number | undefined {
  return readTelegramConfig().linkedChatId
}

function parseCommand(text: string): { cmd: string; arg: string } {
  const trimmed = text.trim()
  const space = trimmed.indexOf(' ')
  if (space === -1) return { cmd: trimmed, arg: '' }
  return { cmd: trimmed.slice(0, space), arg: trimmed.slice(space + 1).trim() }
}

/** Extract image blocks from WrappedMessage content for Telegram sendPhoto. */
interface ImageBlock {
  base64: string
  mediaType: string
  caption?: string
}

function extractImages(message: WrappedMessage): ImageBlock[] {
  const content = message.message?.content
  if (!Array.isArray(content)) return []
  const images: ImageBlock[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'image') {
      const src = (block as { source?: { data?: string; media_type?: string } }).source
      if (src?.data) {
        images.push({ base64: src.data, mediaType: src.media_type ?? 'image/png' })
      }
    }
    if (block && typeof block === 'object' && block.type === 'tool_result') {
      const inner = (block as { content?: unknown[] }).content
      if (Array.isArray(inner)) {
        for (const sub of inner) {
          if (sub && typeof sub === 'object' && (sub as { type?: string }).type === 'image') {
            const src = (sub as { source?: { data?: string; media_type?: string } }).source
            if (src?.data) {
              images.push({ base64: src.data, mediaType: src.media_type ?? 'image/png' })
            }
          }
        }
      }
    }
  }
  return images
}

async function handleUpdate(
  update: TelegramUpdate,
  options: TelegramBridgeOptions,
): Promise<void> {
  // ---- Handle callback_query (inline keyboard button taps) ----
  if (update.callback_query) {
    const cq = update.callback_query
    const chatId = cq.message?.chat.id
    if (chatId === undefined) return

    // Only the linked chat can use inline keyboards
    if (chatId !== linkedChatId()) {
      await answerCallbackQuery(options.token, cq.id)
      return
    }

    const data = cq.data ?? ''
    // Try connect wizard first
    if (data.startsWith('cnx:')) {
      await handleCallbackQuery(options.token, cq.id, chatId, data)
    } else {
      // Unknown callback — just dismiss the spinner
      await answerCallbackQuery(options.token, cq.id)
    }
    return
  }

  // ---- Handle regular messages ----
  const message = update.message
  const text = message?.text
  if (!message || !text) return
  const chatId = message.chat.id
  const username = message.from?.username ?? message.chat.username

  const { cmd, arg } = parseCommand(text)

  // Pairing commands work from any chat.
  if (cmd === '/link' || cmd === '/start') {
    if (!arg) {
      await sendMessage(options.token, chatId, 'Send /link <token> with the token from `/telegram-bot`.')
      return
    }
    const bound = consumePendingToken(arg, chatId, username)
    if (bound) {
      await sendMessage(
        options.token,
        chatId,
        `✅ Linked to ${hostname()}${username ? ` as @${username}` : ''}.\n\nSend any message to drive the CLI. Use /disconnect to unlink.\n\nTip: Use /connect to set up your AI provider.`,
      )
    } else {
      await sendMessage(options.token, chatId, '❌ Invalid or expired token.')
    }
    return
  }

  // /disconnect and /stop both unlink from any chat (security: allow owner to revoke).
  if (cmd === '/disconnect' || cmd === '/stop') {
    if (chatId === linkedChatId()) {
      unlink()
      await sendMessage(options.token, chatId, '🔌 Disconnected. Run `/telegram-bot` in the CLI to link again.')
    }
    return
  }

  // Only the linked chat drives the CLI.
  if (chatId !== linkedChatId()) return

  // Permission reply (y/n/always) takes priority.
  if (handlePermissionReply(text)) return

  // If a /connect wizard session is active, intercept text input for it.
  if (isConnectSessionActive(chatId)) {
    const handled = await handleConnectTextInput(options.token, chatId, text)
    if (handled) return
  }

  // Built-in connect/model/provider commands (slash commands).
  if (cmd === '/connect') {
    await handleConnectCommand(options.token, chatId)
    return
  }

  if (cmd === '/model') {
    await handleModelCommand(options.token, chatId, arg)
    return
  }

  if (cmd === '/provider' || cmd === '/providers') {
    await handleProviderCommand(options.token, chatId)
    return
  }

  // Other slash commands → REPL command queue.
  // Keep the leading slash so the CLI recognises it as a command (not plain text).
  if (text.startsWith('/')) {
    enqueue({ value: text, mode: 'prompt' })
    return
  }

  // Plain text → new REPL turn.
  enqueue({ value: text, mode: 'prompt' })
}

/**
 * Load all CLI commands and register them with Telegram's setMyCommands so the
 * bot shows autocomplete suggestions when the user types /.
 * Telegram limits: 100 commands max, command name ≤32 chars, description ≤256 chars.
 */
async function registerCommandsWithTelegram(token: string): Promise<void> {
  try {
    const { getCommands } = await import('../commands.js')
    const { getCwd } = await import('../utils/cwd.js')
    const allCommands = await getCommands(getCwd())

    // Built-in bridge commands always included (these come first).
    const builtins = [
      { command: 'connect', description: 'Connect a provider and select a model' },
      { command: 'model', description: 'Show or set the active model (/model <name>)' },
      { command: 'provider', description: 'Show all configured providers' },
      { command: 'disconnect', description: 'Unlink this Telegram chat from the CLI' },
    ]

    const fromCli = allCommands
      .filter(cmd => !cmd.isHidden)
      .map(cmd => ({
        // Telegram only allows [a-z0-9_] in command names — replace hyphens with underscores,
        // strip any other invalid characters, and truncate to 32.
        command: cmd.name.replace(/-/g, '_').replace(/[^a-z0-9_]/gi, '').toLowerCase().slice(0, 32),
        description: (cmd.description || cmd.name).slice(0, 256),
      }))
      // Drop commands whose name became empty or too short after sanitization.
      .filter(c => c.command.length >= 1)

    // Dedupe (builtins take precedence over same-named CLI commands).
    const builtinNames = new Set(builtins.map(b => b.command))
    const merged = [
      ...builtins,
      ...fromCli.filter(c => !builtinNames.has(c.command)),
    ].slice(0, 100)

    await setMyCommands(token, merged)
  } catch {
    // Non-fatal
  }
}

export function initTelegramBridge(options: TelegramBridgeOptions): TelegramBridgeHandle {
  let running = true
  let offset = 0
  const permissionCallbacks = createTelegramPermissionCallbacks(options.token)

  // Per-turn streaming mirror — created on startTurn(), finalized on endTurn().
  let mirror: StreamingMirror | null = null

  // Accumulates thinking deltas during a turn; sent as a single message at endTurn.
  let thinkingBuffer = ''
  let thinkingActionSent = false

  const mirrorApi = {
    sendMessage: (chatId: number, text: string) => sendMessage(options.token, chatId, text),
    editMessageText: async (chatId: number, messageId: number, text: string) => {
      const { editMessageText } = await import('./telegramApi.js')
      return editMessageText(options.token, chatId, messageId, text)
    },
    sendChatAction: (chatId: number, action?: 'typing') =>
      sendChatAction(options.token, chatId, action ?? 'typing'),
  }

  // Register CLI commands with Telegram so they appear as autocomplete.
  void registerCommandsWithTelegram(options.token)

  const poll = async (): Promise<void> => {
    while (running) {
      const updates = await getUpdates(options.token, offset)
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1)
        if (!running) break
        try {
          await handleUpdate(update, options)
        } catch {
          // one bad update must not kill the loop
        }
      }
    }
  }
  void poll()

  return {
    permissionCallbacks,

    startTurn(): void {
      const chatId = linkedChatId()
      if (chatId === undefined) return
      thinkingBuffer = ''
      thinkingActionSent = false
      mirror = new StreamingMirror(mirrorApi, chatId)
      void mirror.start().catch(() => {})
    },

    onTextDelta(delta: string): void {
      mirror?.append(delta)
    },

    /**
     * Called for each thinking token delta.
     * - Sends a `typing` chat action on the first thinking token so the user
     *   sees "typing…" in the chat header immediately.
     * - Accumulates all thinking text; it is sent as a single 💭 message at endTurn.
     */
    onThinkingDelta(delta: string): void {
      const chatId = linkedChatId()
      if (chatId === undefined) return
      thinkingBuffer += delta
      // Send the typing indicator once when thinking starts (non-blocking).
      if (!thinkingActionSent) {
        thinkingActionSent = true
        void sendChatAction(options.token, chatId, 'typing')
      }
    },

    async endTurn(): Promise<void> {
      // If there was thinking content this turn, send it as a compact summary
      // before finalizing the streaming mirror.
      if (thinkingBuffer.trim()) {
        const chatId = linkedChatId()
        if (chatId !== undefined) {
          const MAX_THINKING_CHARS = 600
          const thinking = thinkingBuffer.trim()
          const preview =
            thinking.length > MAX_THINKING_CHARS
              ? `${thinking.slice(0, MAX_THINKING_CHARS)}…`
              : thinking
          void sendMessage(options.token, chatId, `💭 ${preview}`).catch(() => {})
        }
        thinkingBuffer = ''
        thinkingActionSent = false
      }
      if (mirror) {
        await mirror.finalize().catch(() => {})
        mirror = null
      }
    },

    pushActivity(messages: WrappedMessage[]): void {
      const chatId = linkedChatId()
      if (chatId === undefined) return
      for (const message of messages) {
        // File change review system messages get their own formatter.
        if (isFileChangeReviewMessage(message)) {
          const text = formatFileChangeReview(message)
          void sendMessage(options.token, chatId, text).catch(() => {})
          continue
        }
        const images = extractImages(message)
        for (const img of images) {
          void sendPhoto(options.token, chatId, img.base64, img.mediaType, img.caption).catch(() => {})
        }
        const text = formatMessage(message, options.toolLabeler)
        if (text) void sendMessage(options.token, chatId, text).catch(() => {})
      }
    },

    stop(): void {
      running = false
    },
  }
}
