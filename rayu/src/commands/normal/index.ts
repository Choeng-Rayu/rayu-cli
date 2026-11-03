import type { Command } from '../../commands.js'

// /normal — exit Orchestrator mode and return to the normal single-agent flow.
// Headless-safe (it only changes the permission mode), so Rayucode can run it too.
const normal = {
  type: 'local',
  name: 'normal',
  description: 'Exit Orchestrator mode (return to normal mode)',
  supportsNonInteractive: true,
  load: () => import('./normal.js'),
} satisfies Command

export default normal
