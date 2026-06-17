import type { Command } from '../../commands.js'
import { rayuFeatureAllowed } from '../../services/rayuAuth/rayuEntitlements.js'
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
  // Gated by the admin-configured `subagent_model` feature.
  isEnabled: () => rayuFeatureAllowed('subagent_model'),
  load: () => import('./command.js'),
} satisfies Command
