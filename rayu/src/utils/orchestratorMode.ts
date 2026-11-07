import type { AppState } from '../state/AppStateStore.js'
import type { PermissionMode } from '../types/permissions.js'
import { getCwd } from './cwd.js'
import { findGitRoot } from './git.js'
import { transitionPermissionMode } from './permissions/permissionSetup.js'

/**
 * Orchestrator mode works in any directory, but its strongest features need git:
 * worktree-isolated packets, a reliable baseline/diff and /undo. Outside git it falls
 * back to file-size/mtime tracking, so tell the user rather than silently downgrading.
 */
export const ORCHESTRATOR_NO_GIT_NOTE =
  'Orchestrator mode works best in a git repository: worktree-isolated packets, ' +
  'reliable change tracking and /undo need git. This directory is not a git ' +
  'repository, so changes are tracked by file size and modification time and ' +
  'worktree packets are unavailable. Consider running the session from a git checkout.'

/** The note to show when Orchestrator runs outside git, or null inside one. */
export function orchestratorNoGitNote(
  gitRoot: string | null = findGitRoot(getCwd()),
): string | null {
  return gitRoot ? null : ORCHESTRATOR_NO_GIT_NOTE
}

/**
 * Orchestrator is a distinct user-facing mode. Permission evaluation treats it
 * like fullManage, while this separate identifier lets both choices remain in
 * the CLI and Rayucode mode selectors.
 * Implementation workers can operate without approval prompts while the main
 * agent is constrained by its orchestrator system reminder to coordination.
 */
export const ORCHESTRATOR_PERMISSION_MODE: PermissionMode = 'orchestrator'

export function getOrchestratorMode(
  state: Pick<AppState, 'toolPermissionContext'>,
): boolean {
  return state.toolPermissionContext.mode === ORCHESTRATOR_PERMISSION_MODE
}

/** Enter Orchestrator mode, or leave it for the normal default mode. */
export function setOrchestratorModeUpdater(
  enabled: boolean,
): (previous: AppState) => AppState {
  return previous => {
    const fromMode = previous.toolPermissionContext.mode
    const toMode = enabled
      ? ORCHESTRATOR_PERMISSION_MODE
      : fromMode === ORCHESTRATOR_PERMISSION_MODE
        ? 'default'
        : fromMode

    if (fromMode === toMode) return previous

    const transitioned = transitionPermissionMode(
      fromMode,
      toMode,
      previous.toolPermissionContext,
    )
    return {
      ...previous,
      toolPermissionContext: { ...transitioned, mode: toMode },
    }
  }
}
