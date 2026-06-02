import type { LocalCommandResult } from '../../types/command.js'
import { readTelegramConfig, unlink, getBotToken } from '../../telegram/telegramConfig.js'
import { sendMessage } from '../../telegram/telegramApi.js'

export async function call(): Promise<LocalCommandResult> {
  const config = readTelegramConfig()
  if (!config.linkedChatId) {
    return { type: 'text', value: 'Telegram bot is not currently linked.' }
  }
  const username = config.linkedUsername ? `@${config.linkedUsername}` : 'the linked chat'
  const token = getBotToken()
  if (token) {
    void sendMessage(token, config.linkedChatId, '🔌 CLI disconnected. Run `/telegram-bot` to link again.').catch(() => {})
  }
  unlink()
  return { type: 'text', value: `Disconnected Telegram bot (was linked to ${username}).` }
}
