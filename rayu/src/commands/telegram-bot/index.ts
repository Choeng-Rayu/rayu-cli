import type { Command } from '../../commands.js'

const telegramBot = {
  type: 'local-jsx',
  name: 'telegram-bot',
  description: 'Link a Telegram bot to drive this CLI remotely',
  // Admin-configured paid feature: stays visible; dispatcher soft-gates execution.
  paidFeature: 'telegram',
  load: () => import('./telegram-bot.js'),
} satisfies Command

export default telegramBot
