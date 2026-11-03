import type { AppState } from '../state/AppStateStore.js'
import type { PermissionMode } from '../types/permissions.js'
import { transitionPermissionMode } from './permissions/permissionSetup.js'

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
