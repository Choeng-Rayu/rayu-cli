/**
 * Feeds `file_changed` events into the change tracker.
 *
 * Same one-way dependency shape as the permission broker's installer: the
 * tracker stays a pure store, the workspace manager stays free of bus
 * knowledge, and this module is the only place that joins them. Nothing in
 * `core/` imports either, so the whole workspace layer is optional.
 */

import { getCwd } from '../../utils/cwd.js'
import { subscribeToEvents } from '../core/eventBus.js'
import { recordFileChange } from './changeTracker.js'
import { workspaceRootFor } from './workspaceManager.js'

let unsubscribe: (() => void) | null = null

/** Start tracking. Idempotent — replaces any previous subscription. */
export function installWorkspaceTracking(): () => void {
  uninstallWorkspaceTracking()
  unsubscribe = subscribeToEvents(event => {
    if (event.type !== 'file_changed') return
    // The agent's own root, so a worktree-isolated agent's paths never collide
    // with a shared-directory agent's. Falls back to RAYU's cwd for an adopted
    // agent RAYU never prepared a workspace for.
    recordFileChange(event, workspaceRootFor(event.agentId, getCwd()))
  })
  return uninstallWorkspaceTracking
}

export function uninstallWorkspaceTracking(): void {
  unsubscribe?.()
  unsubscribe = null
}
