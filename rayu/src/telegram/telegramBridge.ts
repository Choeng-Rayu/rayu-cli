/** In-process Telegram bridge: relays chat messages <-> REPL with no middle server. */

import { hostname } from 'os'
import { formatMessage, type ToolLabeler, type WrappedMessage } from './formatActivity.js'
import {
  consumePendingToken,
  readTelegramConfig,
  unlink,
} from './telegramConfig.js'
import {
  getUpdates,
  sendMessage,
  type TelegramUpdate,
} from './telegramApi.js'


export interface TelegramBridgeOptions {
  token: string
  /** Inject a prompt into the REPL as a new turn (REPL.handleIncomingPrompt). */
  onInboundPrompt: (text: string) => void
  /** Maps a tool name + input to its CLI-facing label. */
  toolLabeler?: ToolLabeler
}

export interface TelegramBridgeHandle {
  /** Mirror REPL messages (user/assistant) to the linked chat. */
  pushActivity: (messages: WrappedMessage[]) => void
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

async function handleUpdate(
  update: TelegramUpdate,
  options: TelegramBridgeOptions,
): Promise<void> {
  const message = update.message
  const text = message?.text
  if (!message || !text) return
  const chatId = message.chat.id
  const username = message.from?.username ?? message.chat.username

  // `/start <token>` (deep-link) and `/link <token>` both pair.
  const { cmd, arg } = parseCommand(text)
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
        `✅ Linked to ${hostname()}${username ? ` as @${username}` : ''}. Send a message to drive the CLI.`,
      )
    } else {
      await sendMessage(options.token, chatId, '❌ Invalid or expired token.')
    }
    return
  }

  if (cmd === '/stop') {
    if (chatId === linkedChatId()) {
      unlink()
      await sendMessage(options.token, chatId, '🔌 Unlinked. Run /telegram-bot to link again.')
    }
    return
  }

  // Only the linked chat can drive the CLI. All other chats are ignored.
  if (chatId !== linkedChatId()) return
  options.onInboundPrompt(text)
}

export function initTelegramBridge(options: TelegramBridgeOptions): TelegramBridgeHandle {
  let running = true
  let offset = 0

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
    pushActivity: (messages: WrappedMessage[]): void => {
      const chatId = linkedChatId()
      if (chatId === undefined) return
      for (const message of messages) {
        const text = formatMessage(message, options.toolLabeler)
        if (text) void sendMessage(options.token, chatId, text).catch(() => {})
      }
    },
    stop: (): void => {
      running = false
    },
  }
}
