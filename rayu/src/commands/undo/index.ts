import type { Command } from '../../commands.js'

const undo = {
  description: 'Undo pending Rayu file changes',
  name: 'undo',
  argumentHint: '[file]',
  type: 'local',
  supportsNonInteractive: false,
  load: () => import('./undo.js'),
} satisfies Command

export default undo
