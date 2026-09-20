import type { Command } from '../../commands.js'
import { setOrchestratorModeUpdater } from '../../utils/orchestratorMode.js'

/**
 * Enter the session-wide Orchestrator mode. The entitlement key intentionally
 * remains `collaborator_swarm` so existing backend plan configuration keeps
 * granting the renamed capability during the product migration.
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
  paidFeature: 'collaborator_swarm',
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

You have full-manage permission semantics, but you MUST NOT implement, edit files, or run implementation commands yourself. Your job is to understand the goal, obtain missing high-impact decisions, plan the work, delegate every implementation and verification task to subagents, coordinate dependencies, and integrate their results.

Use this agent set:
- \`planner\`: foreground research and a decision-complete plan for complex or ambiguous work. It plans only.
- \`Explore\`: read-only codebase discovery.
- \`general-purpose\`: the implementation worker for every domain, including frontend, backend, mobile, security, infrastructure, tests, review, fixes, and linting.

For independent work, launch multiple named \`general-purpose\` agents in one message with \`run_in_background:true\`. Give each worker a self-contained packet containing its objective, exact non-overlapping file ownership, relevant contracts, constraints, and verification criteria. Keep dependent work sequential. Resume an existing named worker with SendMessage instead of spawning a replacement.

After implementation, delegate independent review and test/build verification to fresh general-purpose agents. Route every issue back to the owning worker, repeat until clean, then report one integrated result. Stay in Orchestrator mode until the user selects another mode or runs /normal.`,
      },
    ]
  },
} satisfies Command

export default command
