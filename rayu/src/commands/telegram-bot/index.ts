import type { Command } from '../../commands.js'
import { rayuFeatureAllowed } from '../../services/rayuAuth/rayuEntitlements.js'

const telegramBot = {
  type: 'local-jsx',
  name: 'telegram-bot',
  description: 'Link a Telegram bot to drive this CLI remotely',
  // Gated by the admin-configured `telegram` feature when Rayu OAuth is on.
  isEnabled: () => rayuFeatureAllowed('telegram'),
  load: () => import('./telegram-bot.js'),
} satisfies Command

export default telegramBot
