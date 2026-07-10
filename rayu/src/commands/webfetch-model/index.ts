import type { Command } from '../../commands.js'
import { getWebFetchModelSelection } from '../../utils/rayuConfig.js'

export default {
  type: 'local-jsx',
  name: 'webfetch_model',
  get description() {
    const sel = getWebFetchModelSelection()
    return sel
      ? `Set the model used by WebFetch (currently ${sel})`
      : 'Set the model used by WebFetch (currently the active provider’s model)'
  },
  argumentHint: '[default|show]',
  load: () => import('./command.js'),
} satisfies Command
