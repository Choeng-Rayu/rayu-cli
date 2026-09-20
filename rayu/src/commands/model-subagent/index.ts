import type { Command } from '../../commands.js'
import { getSubagentSelection } from '../../utils/rayuConfig.js'

export default {
  type: 'local-jsx',
  name: 'subagent_models',
  aliases: ['model_subagent', 'subagent_model'],
  get description() {
    const sel = getSubagentSelection()
    return sel
      ? `Set models for all agents or one agent (global: ${sel.model} · ${sel.providerId})`
      : 'Set models for all agents or one agent (default: each agent uses its built-in model)'
  },
  argumentHint: '[AGENT] [default|show]',
  // Admin-configured paid feature: stays visible to everyone; the dispatcher
  // soft-gates execution (Free users get an upgrade notice, paid users run it).
  paidFeature: 'subagent_model',
  load: () => import('./command.js'),
} satisfies Command
