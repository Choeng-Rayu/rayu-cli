import type { Command } from '../../commands.js'
import { isUseRayuOAuthEnabled } from '../../services/rayuAuth/rayuSession.js'

const usage = {
  type: 'local',
  name: 'usage',
  description: 'Show your Rayu plan + hosted-model usage',
  // Only meaningful when Rayu account login is enabled.
  isEnabled: () => isUseRayuOAuthEnabled(),
  supportsNonInteractive: true,
  load: () => import('./usage.js'),
} satisfies Command

export default usage
