import type { Command } from '../../commands.js'
import { rayuFeatureAllowed } from '../../services/rayuAuth/rayuEntitlements.js'

export default {
  type: 'local-jsx',
  name: 'collaborator_model',
  description:
    'Set the model for collaborators (frontend/backend/mobile/security/deploy). With no name, applies to all; default is inherit from the main agent.',
  argumentHint: '[collaborator] [default|show]',
  // Gated by the admin-configured `collaborator_model` feature.
  isEnabled: () => rayuFeatureAllowed('collaborator_model'),
  load: () => import('./command.js'),
} satisfies Command
