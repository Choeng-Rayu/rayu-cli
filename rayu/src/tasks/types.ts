// Union of all concrete task state types
// Use this for components that need to work with any task type

import { isTerminalTaskStatus } from '../Task.js'
import type { DreamTaskState } from './DreamTask/DreamTask.js'
import type { ExternalAgentTaskState } from './ExternalAgentTask/guards.js'
import type { InProcessTeammateTaskState } from './InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from './LocalAgentTask/LocalAgentTask.js'
import type { LocalShellTaskState } from './LocalShellTask/guards.js'
import type { LocalWorkflowTaskState } from './LocalWorkflowTask/LocalWorkflowTask.js'
import type { MonitorMcpTaskState } from './MonitorMcpTask/MonitorMcpTask.js'
import type { RemoteAgentTaskState } from './RemoteAgentTask/RemoteAgentTask.js'

export type TaskState =
  | LocalShellTaskState
  | LocalAgentTaskState
  | RemoteAgentTaskState
  | InProcessTeammateTaskState
  | LocalWorkflowTaskState
  | MonitorMcpTaskState
  | DreamTaskState
  | ExternalAgentTaskState

// Task types that can appear in the background tasks indicator
export type BackgroundTaskState =
  | LocalShellTaskState
  | LocalAgentTaskState
  | RemoteAgentTaskState
  | InProcessTeammateTaskState
  | LocalWorkflowTaskState
  | MonitorMcpTaskState
  | DreamTaskState
  | ExternalAgentTaskState

/**
 * Check if a task should be shown in the background tasks indicator.
 * A task is considered a background task if:
 * 1. It is running or pending
 * 2. It has been explicitly backgrounded (not a foreground task)
 */
export function isBackgroundTask(task: TaskState): task is BackgroundTaskState {
  if (task.status !== 'running' && task.status !== 'pending') {
    return false
  }
  // Foreground tasks (isBackgrounded === false) are not yet "background tasks"
  if ('isBackgrounded' in task && task.isBackgrounded === false) {
    return false
  }
  return true
}

/**
 * How long a background agent that has finished may take to queue its notification
 * before the request stops waiting for it.
 *
 * An agent's lifecycle marks its task finished first, so TaskOutput unblocks, and
 * queues the notification after its worktree cleanup, which runs git. That gap is
 * normally well under a second. The bound only keeps a hung cleanup from holding
 * the request open.
 */
export const AGENT_NOTIFICATION_GRACE_MS = 30_000

/**
 * Whether background agents still have work for the request that launched them: one
 * is running, or one has finished and its notification is not queued yet.
 *
 * The headless engine holds a turn's `result` back while this is true, and the
 * terminal keeps the turn's Rayu credits open for the same reason: the agents' model
 * calls, and the turns their notifications start, are part of what the user's
 * message cost. The finished-but-not-queued case matters for a worktree agent: the
 * request must not end while git runs, or the agent's notification turn would
 * start a new total. Shells, monitors and teammates do not count here: a dev server
 * can run for the whole session, and teammates are long-lived by design.
 */
export function hasUnfinishedBackgroundAgent(
  tasks: Readonly<Record<string, TaskState>> | undefined,
): boolean {
  const now = Date.now()
  return Object.values(tasks ?? {}).some(task =>
    isUnfinishedBackgroundAgent(task, now),
  )
}

function isUnfinishedBackgroundAgent(task: TaskState, now: number): boolean {
  if (task.type !== 'local_agent' && task.type !== 'local_workflow') return false
  // A foreground agent's result is its tool call's result, not a notification.
  if ('isBackgrounded' in task && task.isBackgrounded === false) return false
  if (task.status === 'running') return true
  return (
    isTerminalTaskStatus(task.status) &&
    !task.notified &&
    task.endTime !== undefined &&
    now - task.endTime < AGENT_NOTIFICATION_GRACE_MS
  )
}
