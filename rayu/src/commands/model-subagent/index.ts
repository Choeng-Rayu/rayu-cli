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
  // Admin-configured paid feature: stays visible to everyone; the dispatcher
  // soft-gates execution (Free users get an upgrade notice, paid users run it).
  paidFeature: 'subagent_model',
  load: () => import('./command.js'),
} satisfies Command
