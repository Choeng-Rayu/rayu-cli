import type { Command } from '../../commands.js'
import { ORCHESTRATOR_PAID_FEATURE } from '../../constants/orchestrator.js'
import { setOrchestratorModeUpdater } from '../../utils/orchestratorMode.js'

/**
 * Enter the session-wide Orchestrator mode. The entitlement key intentionally
 * remains `collaborator_swarm` so existing backend plan configuration keeps
 * granting the renamed capability during the product migration.
 *
 * The rules themselves are NOT repeated here. Entering the mode makes the
 * Orchestrator reminder attach in full on this very turn (src/orchestrator/
 * reminder.ts), and that reminder is the single place the rules are written.
 */
const command = {
  type: 'prompt',
  name: 'orchestrator',
  description:
    'Enter Orchestrator mode: delegate implementation to parallel subagents with full tool access. /normal exits.',
  argumentHint: '[task description]',
  contentLength: 0,
  progressMessage: 'starting Orchestrator mode',
  source: 'builtin',
  paidFeature: ORCHESTRATOR_PAID_FEATURE,
  async getPromptForCommand(args: string, context) {
    context?.setAppState?.(setOrchestratorModeUpdater(true))
    const task = (args ?? '').trim()
    const taskLine = task
      ? `The task to orchestrate:\n\n${task}`
      : 'Orchestrate the current task or the plan already established in this conversation.'

    return [
      {
        type: 'text' as const,
        text: `The user explicitly entered Orchestrator mode. You are the ORCHESTRATOR for this task.

${taskLine}

Follow the Orchestrator mode rules in the system reminder. First make sure you understand the goal and ask the user about any high-impact decision the code cannot answer. Then plan, delegate every implementation and verification step to subagents, and integrate their results. Do not implement anything yourself. Stay in Orchestrator mode until the user selects another mode or runs /normal.`,
      },
    ]
  },
} satisfies Command

export default command
