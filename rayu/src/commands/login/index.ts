import type { Command } from '../../commands.js'
import { isUseRayuOAuthEnabled } from '../../services/rayuAuth/rayuSession.js'

const login = {
  type: 'local',
  name: 'login',
  description: 'Sign in to your Rayu account',
  // Only available when Rayu account login is enabled (USE_RAYU_OAUTH=true).
  isEnabled: () => isUseRayuOAuthEnabled(),
  // Requires an interactive browser flow.
  supportsNonInteractive: false,
  load: () => import('./login.js'),
} satisfies Command

export default login
