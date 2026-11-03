import type { LocalCommandCall } from '../../types/command.js'
import {
  isRemoteUninstallAllowed,
  setRemoteUninstallAllowed,
} from '../../telegram/telegramConfig.js'

/**
 * `/telegram-remote-uninstall [on|off]` — the local opt-in for remote uninstall.
 *
 * MUST RUN AT THE MACHINE. This command is listed in TELEGRAM_SEMANTIC_HAZARDS
 * (see telegramBridge.isBlockedFromTelegram), so it cannot be invoked from
 * Telegram. That is the point: if the chat could run it, the chat could grant
 * itself the capability to wipe the machine, and every other control on the
 * uninstall path would be decoration.
 */
export const call: LocalCommandCall = async (args, _context) => {
  const choice = args.trim().toLowerCase()

  if (choice !== 'on' && choice !== 'off') {
    const state = isRemoteUninstallAllowed() ? 'ENABLED' : 'disabled'
    return {
      type: 'text',
      value: [
        `Remote uninstall over Telegram is currently ${state}.`,
        '',
        'When enabled, /uninstall in your linked Telegram chat can remove RAYU',
        'from this machine — the CLI, its configuration, and your saved provider',
        'API keys. It still requires you to name the device and type a',
        'time-limited confirmation code, and it never touches your projects or',
        'git repositories.',
        '',
        'It is off by default because it cannot be undone: with it on, access to',
        'your Telegram account is enough to destroy this install.',
        '',
        'Usage:',
        '  /telegram-remote-uninstall on',
        '  /telegram-remote-uninstall off',
      ].join('\n'),
    }
  }

  const enable = choice === 'on'
  setRemoteUninstallAllowed(enable)

  return {
    type: 'text',
    value: enable
      ? [
          '⚠️ Remote uninstall is now ENABLED for this machine.',
          '',
          '/uninstall in your linked Telegram chat can now remove RAYU from here.',
          'You will still have to name the device and type a confirmation code.',
          '',
          'Turn it back off with: /telegram-remote-uninstall off',
        ].join('\n')
      : [
          '✅ Remote uninstall is now disabled for this machine.',
          '',
          '/uninstall from Telegram will be refused.',
        ].join('\n'),
  }
}
