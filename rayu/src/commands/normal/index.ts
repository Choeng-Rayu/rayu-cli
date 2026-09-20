import type { Command } from '../../commands.js'

// /normal — exit Orchestrator mode and return to the normal single-agent flow.
const normal = {
  type: 'local',
  name: 'normal',
  description: 'Exit Orchestrator mode (return to normal mode)',
  supportsNonInteractive: false,
  load: () => import('./normal.js'),
} satisfies Command

export default normal
