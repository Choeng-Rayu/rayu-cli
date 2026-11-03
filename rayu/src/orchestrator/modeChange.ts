/**
 * Warn when a permission-mode change takes auto-approval away from running workers.
 *
 * Background workers re-read the parent's mode on every permission check
 * (`agentGetAppState`, src/tools/AgentTool/runAgent.ts) and cannot show a prompt, so a
 * check that would ask is denied. Switching from Orchestrator — or Full Manage / bypass —
 * to a prompting mode while they run silently starts failing their edits and commands.
 * This turns that into a visible warning in both the CLI and Rayucode.
 */
import type { AppState } from '../state/AppStateStore.js'
import { isBackgroundTask } from '../tasks/types.js'
import type { PermissionMode } from '../types/permissions.js'
import { permissionModeTitle } from '../utils/permissions/PermissionMode.js'

/** Modes in which background workers' tool calls are approved without asking. */
const AUTO_APPROVING_MODES: ReadonlySet<PermissionMode> = new Set<PermissionMode>([
  'orchestrator',
  'fullManage',
  'bypassPermissions',
])

export type WorkerApprovalLoss = {
  fromMode: PermissionMode
  toMode: PermissionMode
  workers: ReadonlyArray<{ taskId: string; description: string }>
}

/** The warning due for this state change, or null when none is. */
export function describeWorkerApprovalLoss(
  oldState: Pick<AppState, 'toolPermissionContext'>,
  newState: Pick<AppState, 'toolPermissionContext' | 'tasks'>,
): WorkerApprovalLoss | null {
  const fromMode = oldState.toolPermissionContext.mode
  const toMode = newState.toolPermissionContext.mode
  if (!AUTO_APPROVING_MODES.has(fromMode) || AUTO_APPROVING_MODES.has(toMode)) {
    return null
  }
  const workers = Object.values(newState.tasks ?? {})
    .filter(task => task.type === 'local_agent' && isBackgroundTask(task))
    .map(task => ({ taskId: task.id, description: task.description }))
  return workers.length > 0 ? { fromMode, toMode, workers } : null
}

/** A warning the user can act on, shared by the CLI and Rayucode. */
export function formatWorkerApprovalLoss(loss: WorkerApprovalLoss): string {
  const count = loss.workers.length
  const names = loss.workers.map(worker => worker.description).join(', ')
  const running = `${count} background ${count === 1 ? 'worker is' : 'workers are'} still running (${names}).`
  return `${running} Now that the mode is ${permissionModeTitle(loss.toMode)}, workers cannot ask for approval, so their edits and commands that need approval will be denied. Switch back to ${permissionModeTitle(loss.fromMode)} to let them finish.`
}
