import type { Command } from '../../commands.js'

const telegramBot = {
  type: 'local-jsx',
  name: 'telegram-bot',
  description: 'Link a Telegram bot to drive this CLI remotely',
  load: () => import('./telegram-bot.js'),
} satisfies Command

export default telegramBot
