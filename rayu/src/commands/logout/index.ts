import type { Command } from '../../commands.js'
import { isUseRayuOAuthEnabled } from '../../services/rayuAuth/rayuSession.js'

const logout = {
  type: 'local',
  name: 'logout',
  description: 'Sign out of your Rayu account',
  isEnabled: () => isUseRayuOAuthEnabled(),
  supportsNonInteractive: true,
  load: () => import('./logout.js'),
} satisfies Command

export default logout
