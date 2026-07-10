import type { Command } from '../../commands.js'
import { isUseRayuOAuthEnabled } from '../../services/rayuAuth/rayuSession.js'

const billing = {
  type: 'local',
  name: 'billing',
  description: 'Show your current Rayu plan and upgrade on the web',
  // Only meaningful when Rayu account login is enabled (USE_RAYU_OAUTH=true).
  isEnabled: () => isUseRayuOAuthEnabled(),
  supportsNonInteractive: true,
  load: () => import('./billing.js'),
} satisfies Command

export default billing
