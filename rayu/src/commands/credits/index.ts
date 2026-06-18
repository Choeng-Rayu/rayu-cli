import type { Command } from '../../commands.js'
import { isUseRayuOAuthEnabled } from '../../services/rayuAuth/rayuSession.js'

const credits = {
  type: 'local',
  name: 'credits',
  description: 'Show your Rayu hosted-model credit usage',
  // Only meaningful when Rayu account login is enabled.
  isEnabled: () => isUseRayuOAuthEnabled(),
  supportsNonInteractive: true,
  load: () => import('./credits.js'),
} satisfies Command

export default credits
