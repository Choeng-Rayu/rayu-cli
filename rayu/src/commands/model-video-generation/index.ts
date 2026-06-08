import type { Command } from '../../commands.js'
import { getVideoModelSelection } from '../../utils/rayuConfig.js'

export default {
  type: 'local-jsx',
  name: 'model_video_generation',
  get description() {
    const sel = getVideoModelSelection()
    return sel
      ? `Set the video generation model (currently ${sel})`
      : 'Set the video generation model (default: NVIDIA/fal)'
  },
  load: () => import('./command.js'),
} satisfies Command
