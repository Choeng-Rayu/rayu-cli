import type { LocalCommandResult } from '../../types/command.js'
import {
  getBotToken,
  getTelegramMode,
  readTelegramConfig,
  unlink,
} from '../../telegram/telegramConfig.js'
import { sendMessage } from '../../telegram/telegramApi.js'
import { deleteHostedLink, relayHostedSend } from '../../telegram/telegramHostedApi.js'

export async function call(): Promise<LocalCommandResult> {
  const config = readTelegramConfig()
  if (!config.linkedChatId) {
    return { type: 'text', value: 'Telegram bot is not currently linked.' }
  }
  const username = config.linkedUsername ? `@${config.linkedUsername}` : 'the linked chat'

  if (getTelegramMode() === 'hosted') {
    // Shared Rayu bot: notify the chat + unlink server-side. chat_id is forced
    // by the backend to the caller's own link.
    await relayHostedSend('sendMessage', {
      text: '🔌 CLI disconnected. Run /telegram-bot to link again.',
    }).catch(() => {})
    await deleteHostedLink()
  } else {
    const token = getBotToken()
    if (token) {
      void sendMessage(
        token,
        config.linkedChatId,
        '🔌 CLI disconnected. Run `/telegram-bot` to link again.',
      ).catch(() => {})
    }
  }
  unlink()
  return { type: 'text', value: `Disconnected Telegram bot (was linked to ${username}).` }
}
