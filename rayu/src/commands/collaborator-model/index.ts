import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'collaborator_model',
  description:
    'Set the model for collaborators (frontend/backend/mobile/security/deploy). With no name, applies to all; default is inherit from the main agent.',
  argumentHint: '[collaborator] [default|show]',
  load: () => import('./command.js'),
} satisfies Command
