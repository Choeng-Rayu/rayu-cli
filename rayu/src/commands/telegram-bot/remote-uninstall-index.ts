import type { Command } from '../../commands.js'

/**
 * Local opt-in for Telegram remote uninstall.
 *
 * `supportsNonInteractive: true` so it works in scripts, but the command name is
 * on the Telegram blocked list (TELEGRAM_SEMANTIC_HAZARDS) — it must be run at
 * the machine, not from the chat that would gain the capability.
 */
const telegramRemoteUninstall = {
  type: 'local',
  supportsNonInteractive: true,
  name: 'telegram-remote-uninstall',
  description:
    'Allow or forbid /uninstall from Telegram removing RAYU from this machine',
  load: () => import('./remote-uninstall.js'),
} satisfies Command

export default telegramRemoteUninstall
