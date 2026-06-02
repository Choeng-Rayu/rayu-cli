import type { Command } from '../../commands.js'

const keep = {
  description: 'Keep pending Rayu file changes',
  name: 'keep',
  argumentHint: '[file]',
  type: 'local',
  supportsNonInteractive: false,
  load: () => import('./keep.js'),
} satisfies Command

export default keep
