import type { LocalCommandCall } from '../../types/command.js'
import {
  getBotToken,
  getTelegramMode,
  readTelegramConfig,
  unlink,
} from '../../telegram/telegramConfig.js'
import { sendMessage } from '../../telegram/telegramApi.js'
import { deleteHostedLink, relayHostedSend } from '../../telegram/telegramHostedApi.js'

export const call: LocalCommandCall = async (_args, context) => {
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
      await sendMessage(
        token,
        config.linkedChatId,
        '🔌 CLI disconnected. Run `/telegram-bot` to link again in your rayu cli session.',
      ).catch(() => {})
    }
  }
  unlink()

  // Stop the running bridge. Clearing the link alone left the bridge alive: it
  // kept long-polling the old bot, and because it captures its transport at
  // init, a later connect to a different bot reused the OLD bot's token — so
  // messages went to the previous bot while the UI reported success. Lowering
  // this flag is what makes useTelegramBridge tear the transport down.
  //
  // Ordered after unlink() so the teardown sees no linked chat and does not send
  // a second goodbye on top of the one above.
  context.setAppState(prev => ({
    ...prev,
    telegramBridgeActive: false,
    telegramTransportKey: undefined,
    telegramPermissionCallbacks: undefined,
  }))

  return { type: 'text', value: `Disconnected Telegram bot (was linked to ${username}).` }
}
