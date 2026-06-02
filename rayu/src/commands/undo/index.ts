import type { Command } from '../../commands.js'

const undo = {
  description: 'Undo the latest pending Rayu file change',
  name: 'undo',
  argumentHint: '',
  type: 'local',
  supportsNonInteractive: false,
  load: () => import('./undo.js'),
} satisfies Command

export default undo
