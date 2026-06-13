import type { Command } from '../../commands.js'

// /normal — exit collaborator-swarm mode and return to the normal single-agent
// flow. The counterpart to /collaborator_swarm.
const normal = {
  type: 'local',
  name: 'normal',
  description: 'Exit collaborator_swarm mode (return to normal mode)',
  supportsNonInteractive: false,
  load: () => import('./normal.js'),
} satisfies Command

export default normal
