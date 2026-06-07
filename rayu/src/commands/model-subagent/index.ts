import type { Command } from '../../commands.js'
import { getSubagentSelection } from '../../utils/rayuConfig.js'

export default {
  type: 'local-jsx',
  name: 'model_subagent',
  get description() {
    const sel = getSubagentSelection()
    return sel
      ? `Set the model used by subagents (currently ${sel.model} · ${sel.providerId})`
      : 'Set the model used by subagents (currently the main provider’s instant model)'
  },
  argumentHint: '[AGENT] [default|show]',
  load: () => import('./command.js'),
} satisfies Command
