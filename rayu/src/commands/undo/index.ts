import type { Command } from '../../commands.js'

const undo = {
  description: 'Undo pending Rayu file changes (use "all" to undo everything)',
  name: 'undo',
  argumentHint: '[file|all]',
  type: 'local',
  supportsNonInteractive: true,
  load: () => import('./undo.js'),
} satisfies Command

export default undo
