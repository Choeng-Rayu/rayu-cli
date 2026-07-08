import type { Command } from '../../commands.js'

const command = {
  name: 'mascot',
  description: 'Select which mascot the startup banner shows',
  argumentHint: '[goose]',
  supportsNonInteractive: false,
  type: 'local',
  load: () => import('./mascot.js'),
} satisfies Command

export default command
