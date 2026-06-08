import type { Command } from '../../commands.js'
import { getImageModelSelection } from '../../utils/rayuConfig.js'

export default {
  type: 'local-jsx',
  name: 'model_image_generation',
  get description() {
    const sel = getImageModelSelection()
    return sel
      ? `Set the image generation/editing model (currently ${sel})`
      : 'Set the image generation/editing model (default: NVIDIA)'
  },
  load: () => import('./command.js'),
} satisfies Command
