/**
 * Wires the orchestration runner to the real manager, task registry and
 * workspace map.
 *
 * This is the only module in `orchestration/` that knows about `AgentManager`,
 * `setAppState` or the task framework. Keeping it separate is what lets
 * `runner.ts` be driven by fakes — a race, a mid-flight disconnect and an
 * exhausted retry budget are all impossible to reproduce reliably against real
 * subprocesses, and a policy engine that cannot be tested is a policy engine
 * that quietly rots.
 */

import type { SetAppState } from '../../Task.js'
import {
  allocateAgentId,
  assign,
  findLiveAgent,
  startAgent,
} from '../core/AgentManager.js'
import {
  asTaskRef,
  type AgentInstanceId,
  type AgentSessionId,
  type ProviderId,
} from '../core/types.js'
import { registerExternalAgentTask } from '../../tasks/ExternalAgentTask/ExternalAgentTask.js'
import { getCwd } from '../../utils/cwd.js'
import {
  prepareWorkspace,
  releaseWorkspace,
  workspaceRootFor,
} from '../workspace/workspaceManager.js'
import type { StepTarget } from './plan.js'
import type { OrchestrationDeps, PreparedStep } from './runner.js'
import { awaitTaskOutcome } from './taskOutcome.js'

/**
 * Build the production dependency set.
 *
 * `setAppState` is required because every delegated step becomes a real
 * `external_agent` task — that is what routes the agent's output into
 * `TaskOutput` and makes the work visible in `/tasks` instead of happening
 * invisibly inside a plan.
 */
export function createOrchestrationDeps(
  setAppState: SetAppState,
): OrchestrationDeps {
  return {
    async prepare(
      target: StepTarget,
      prompt: string,
      label: string,
    ): Promise<PreparedStep> {
      const resolved = await resolveTarget(target)
      const taskId = registerExternalAgentTask(setAppState, {
        agentInstanceId: resolved.agentId,
        provider: resolved.provider,
        prompt,
        agentSessionId: resolved.sessionId,
        externalState: 'queued',
        worktreePath: resolved.worktreePath,
        label,
      })
      const taskRef = asTaskRef(taskId)
      return {
        agentId: resolved.agentId,
        taskRef,
        async start() {
          const outcome = await assign(
            resolved.agentId,
            { text: prompt },
            { taskRef },
          )
          return { action: outcome.action }
        },
      }
    },

    awaitOutcome: awaitTaskOutcome,

    async cancel(taskRef, agentId) {
      // Interrupts the TURN, not the agent — the same rule as
      // `ExternalAgentTask.kill`. A losing race participant should stop working;
      // shutting its process down would be a much larger action, and it may be
      // process-durable or hosting a TUI.
      const { interruptAgent } = await import('../core/AgentManager.js')
      if (!findLiveAgent(agentId)) return
      await interruptAgent(agentId).catch(() => undefined)
      void taskRef
    },

    workspaceRootOf(agentId: AgentInstanceId) {
      // Undefined when RAYU never prepared a workspace for this agent, which
      // `validatePlan` treats as "cannot rule out a shared tree".
      const workspace = workspaceRootFor(agentId, '')
      return workspace === '' ? undefined : workspace
    },
  }
}

type ResolvedTarget = {
  readonly agentId: AgentInstanceId
  readonly provider: ProviderId
  readonly sessionId?: AgentSessionId
  readonly worktreePath?: string
}

async function resolveTarget(target: StepTarget): Promise<ResolvedTarget> {
  if (target.kind === 'agent') {
    const handle = findLiveAgent(target.agentId)
    if (!handle) {
      throw new Error(
        `${target.agentId} is not connected; start or adopt it before using it in a plan.`,
      )
    }
    return {
      agentId: handle.agentId,
      provider: handle.provider,
      sessionId: handle.activeSessionId(),
    }
  }

  const agentId = await allocateAgentId(target.provider)
  const workspace = await prepareWorkspace({
    agentId,
    cwd: getCwd(),
    isolation: target.isolate ? 'worktree' : 'shared',
  })
  if (!workspace.ok) throw new Error(workspace.message)

  try {
    const handle = await startAgent({
      agentId,
      provider: target.provider,
      cwd: workspace.workspace.cwd,
    })
    return {
      agentId: handle.agentId,
      provider: handle.provider,
      sessionId: handle.activeSessionId(),
      worktreePath: workspace.workspace.worktree?.path,
    }
  } catch (error) {
    // Never leave a workspace reserved for an agent that failed to start.
    await releaseWorkspace(agentId)
    throw error
  }
}
