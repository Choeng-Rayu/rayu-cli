import type { Command } from '../../commands.js'

const disconnectTelegram = {
  type: 'local',
  supportsNonInteractive: true,
  name: 'disconnect-telegram',
  description: 'Unlink the Telegram bot from this CLI session',
  load: () => import('./disconnect.js'),
} satisfies Command

export default disconnectTelegram
