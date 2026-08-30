/**
 * Background-task entry for work delegated to a foreign agent CLI.
 *
 * This makes external agent work a first-class RAYU task, so it appears in the
 * footer pill, the Shift+Down dialog and `/tasks`, and so the EXISTING
 * `TaskOutput` / `TaskGet` / `TaskList` / `TaskStop` tools work on it unchanged.
 * `TaskOutputTool` already falls through to `getTaskOutput(task.id)` for task
 * types it does not special-case, and the T3 event sinks write the agent's
 * normalized output there — so no reader needed changing.
 *
 * Task is NOT the agent's session
 * -------------------------------
 * One agent instance can serve several tasks in sequence over one native
 * session, and a task can outlive a turn (queued, or waiting on the provider).
 * `kill` therefore INTERRUPTS the turn serving this task; it does not stop the
 * agent. Stopping the agent is `/agent stop`, which is a different decision —
 * a process-durable agent may be serving other work or hosting a TUI the user
 * is looking at.
 *
 * The state shape and guard live in `./guards.ts` so non-React consumers (the
 * recovery path, `print.ts`, `stopTask.ts`) can use them without pulling this
 * module's dependencies in.
 */

import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import type { SetAppState, Task } from '../../Task.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'
import type {
  AgentInstanceId,
  AgentSessionId,
  ExternalTaskState,
  ProviderId,
} from '../../externalAgents/core/types.js'
import { toRayuTaskStatus } from '../../externalAgents/core/types.js'
import type { AgentId } from '../../types/ids.js'
import type { ExternalAgentTaskState } from './guards.js'

export type { ExternalAgentTaskState } from './guards.js'
export { isExternalAgentTask } from './guards.js'

export function registerExternalAgentTask(
  setAppState: SetAppState,
  params: {
    readonly agentInstanceId: AgentInstanceId
    readonly provider: ProviderId
    readonly prompt: string
    readonly agentSessionId?: AgentSessionId
    readonly externalState: ExternalTaskState
    readonly activeTurnId?: string
    readonly worktreePath?: string
    readonly toolUseId?: string
    readonly agentId?: AgentId
    readonly isBackgrounded?: boolean
    /**
     * Orchestration step label. Prefixed to the description so several
     * concurrent steps are distinguishable in `/tasks` and the footer pill.
     */
    readonly label?: string
  },
): string {
  const id = generateTaskId('external_agent')
  // The description is what the pill and dialog show, so it names the AGENT
  // rather than the provider: with two codex instances running, "codex" alone
  // would be ambiguous in the footer.
  const description = `${params.label ? `[${params.label}] ` : ''}${params.agentInstanceId}: ${firstLine(params.prompt)}`
  const task: ExternalAgentTaskState = {
    ...createTaskStateBase(id, 'external_agent', description, params.toolUseId),
    type: 'external_agent',
    status: toRayuTaskStatus(params.externalState),
    agentInstanceId: params.agentInstanceId,
    provider: params.provider,
    agentSessionId: params.agentSessionId,
    prompt: params.prompt,
    externalState: params.externalState,
    activeTurnId: params.activeTurnId,
    changedFiles: [],
    worktreePath: params.worktreePath,
    agentId: params.agentId,
    isBackgrounded: params.isBackgrounded ?? true,
    lastReportedTotalLines: 0,
  }
  registerTask(task, setAppState)
  return id
}

/**
 * Move a task to a new external state, projecting it onto `TaskStatus`.
 *
 * Terminal transitions are one-way: a `completed` task that receives a late
 * event must not reopen, because the model has already been told it finished
 * and the task may already have been evicted.
 */
export function setExternalTaskState(
  taskId: string,
  setAppState: SetAppState,
  externalState: ExternalTaskState,
  extra?: {
    readonly resultSummary?: string
    readonly errorMessage?: string
    readonly activeTurnId?: string
    readonly agentSessionId?: AgentSessionId
  },
): void {
  updateTaskState<ExternalAgentTaskState>(taskId, setAppState, task => {
    if (isTerminalExternalState(task.externalState)) return task
    const status = toRayuTaskStatus(externalState)
    return {
      ...task,
      externalState,
      status,
      // `notified` is left alone: the model sink owns it, and clearing it here
      // would re-notify on every state change.
      endTime: isTerminalExternalState(externalState) ? Date.now() : undefined,
      activeTurnId: isTerminalExternalState(externalState)
        ? undefined
        : (extra?.activeTurnId ?? task.activeTurnId),
      agentSessionId: extra?.agentSessionId ?? task.agentSessionId,
      resultSummary: extra?.resultSummary ?? task.resultSummary,
      errorMessage: extra?.errorMessage ?? task.errorMessage,
    }
  })
}

/** Record a path the task's agent touched, for the dialog and conflict view. */
export function noteExternalTaskFile(
  taskId: string,
  setAppState: SetAppState,
  path: string,
): void {
  updateTaskState<ExternalAgentTaskState>(taskId, setAppState, task =>
    task.changedFiles.includes(path)
      ? task
      : { ...task, changedFiles: [...task.changedFiles, path] },
  )
}

export function isTerminalExternalState(state: ExternalTaskState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled'
}

function firstLine(prompt: string): string {
  const line = prompt.split('\n', 1)[0] ?? ''
  return line.length > 80 ? `${line.slice(0, 77)}...` : line
}

export const ExternalAgentTask: Task = {
  name: 'ExternalAgentTask',
  type: 'external_agent',

  /**
   * Stop the WORK, not the agent.
   *
   * Interrupts the turn serving this task when one is in flight. The agent stays
   * up: it may be process-durable, serving other tasks, or hosting a TUI the
   * user is looking at, and killing it would be a much larger action than the
   * user asked for.
   */
  async kill(taskId, setAppState) {
    let agentInstanceId: AgentInstanceId | undefined
    let hadActiveTurn = false

    updateTaskState<ExternalAgentTaskState>(taskId, setAppState, task => {
      if (isTerminalExternalState(task.externalState)) return task
      agentInstanceId = task.agentInstanceId
      hadActiveTurn = task.activeTurnId !== undefined
      return {
        ...task,
        externalState: 'cancelled',
        status: 'killed',
        endTime: Date.now(),
        notified: true,
        activeTurnId: undefined,
      }
    })

    if (!agentInstanceId || !hadActiveTurn) return

    // Imported lazily: `src/tasks.ts` is on the startup path and must not pull
    // the orchestrator in, and a task can be killed after the agent is already
    // gone — in which case there is simply nothing to interrupt.
    try {
      const { findLiveAgent, interruptAgent } = await import(
        '../../externalAgents/core/AgentManager.js'
      )
      if (findLiveAgent(agentInstanceId)) {
        await interruptAgent(agentInstanceId)
      }
    } catch (error) {
      // The task is already marked cancelled, which is what the user asked for.
      // A failed interrupt (agent gone, or no turn to interrupt) is not worth
      // failing the kill over.
      logForDebugging(
        `[ExternalAgentTask] could not interrupt ${agentInstanceId}: ${errorMessage(error)}`,
      )
    }
  },
}
