/**
 * Pure type + type guard for ExternalAgentTask state.
 *
 * Split out from the task implementation for the same reason as
 * `LocalShellTask/guards.ts`: non-React consumers (the recovery path, print.ts,
 * `stopTask.ts`) need the shape and the guard without pulling React/ink into
 * their module graph.
 *
 * An ExternalAgentTask is RAYU's record of work delegated to a foreign agent
 * CLI. It is NOT the foreign agent's session — `agentSessionId` points at that,
 * and one task may span several of the agent's own turns.
 */

import type { TaskStateBase } from '../../Task.js'
import type {
  AgentInstanceId,
  AgentSessionId,
  ExternalTaskState,
  ProviderId,
} from '../../externalAgents/core/types.js'
import type { AgentId } from '../../types/ids.js'

export type ExternalAgentTaskState = TaskStateBase & {
  type: 'external_agent'
  /** Which agent instance owns this work, e.g. `codex:agent_01`. */
  agentInstanceId: AgentInstanceId
  provider: ProviderId
  /**
   * The foreign agent's own conversation id (Codex threadId, Claude Code
   * --session-id, OpenCode session id). Persisted so a restart resumes the real
   * conversation rather than starting a fresh one.
   */
  agentSessionId?: AgentSessionId
  /** The prompt RAYU dispatched. */
  prompt: string
  /**
   * Richer than `status` (which is RAYU's generic TaskStatus). Carries `queued`
   * and `waiting-provider`, which the generic framework has no word for.
   */
  externalState: ExternalTaskState
  /** The agent's turn currently serving this task, when one is in flight. */
  activeTurnId?: string
  /** Files this task's agent has touched, for workspace conflict detection. */
  changedFiles: string[]
  /** Worktree provisioned for isolation, when the task runs isolated. */
  worktreePath?: string
  /** Final assistant summary, once completed. */
  resultSummary?: string
  /** Failure detail, once failed. */
  errorMessage?: string
  /** Set when the model (not the user) delegated this work. */
  agentId?: AgentId
  /** Whether the task has been backgrounded (false = running in foreground). */
  isBackgrounded: boolean
  /** Total lines already reported to the model, for delta computation. */
  lastReportedTotalLines: number
}

export function isExternalAgentTask(
  task: unknown,
): task is ExternalAgentTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'external_agent'
  )
}
