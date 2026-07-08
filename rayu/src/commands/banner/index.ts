import type { Command } from '../../commands.js'

const command = {
  name: 'banner',
  description: 'Toggle the startup mascot banner on or off',
  argumentHint: '[on|off]',
  supportsNonInteractive: false,
  type: 'local',
  load: () => import('./banner.js'),
} satisfies Command

export default command
