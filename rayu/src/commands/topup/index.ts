import type { Command } from '../../commands.js'
import { isUseRayuOAuthEnabled } from '../../services/rayuAuth/rayuSession.js'

/**
 * /topup — buy pay-as-you-go credits.
 *
 * The whole flow (QR rendering, polling, the picker UI) is behind `load()` so the
 * qrcode + Select modules are only pulled in when a user actually runs the
 * command; nothing here is imported at CLI startup.
 *
 * Whether top-up is AVAILABLE is a server decision (AppSettings.creditsPerDollar),
 * not a client one, and it can change at runtime — so the command stays visible
 * whenever Rayu login is on and the flow reports "not enabled on this server" if
 * the admin has it switched off. Hiding it here would require a rate lookup at
 * startup, which is exactly the hardcoded/stale-pricing trap this feature avoids.
 */
const topup = {
  type: 'local-jsx',
  name: 'topup',
  description: 'Buy additional Rayu credits (pay-as-you-go)',
  argumentHint: '[credits]',
  aliases: ['buy-credits'],
  // Only meaningful when Rayu account login is enabled (USE_RAYU_OAUTH=true).
  isEnabled: () => isUseRayuOAuthEnabled(),
  load: () => import('./topup.js'),
} satisfies Command

export default topup
