/**
 * Bring conversations that have not started yet up to date with a saved setting.
 *
 * A "new conversations" setting — the reply language, the starting permission mode —
 * would otherwise miss the very next conversation: Rayucode prewarms an engine before
 * the user types, and an open, empty tab already holds a session. Only conversations with
 * nothing to lose are touched: an empty transcript, no turn in flight, and not attached
 * to a terminal session.
 *
 * Free of `vscode` imports; the host supplies the attachment check, the prewarm and the
 * pill update.
 */
import type { EditableSettingDescriptor } from '../../../utils/settings/editableSettings.js'
import { permissionModeById, type PermissionModeView } from '../../shared/permissionModes.js'

export interface RefreshableEntry {
  readonly key: string
  readonly session: {
    readonly transcript: readonly unknown[]
    readonly isTurnRunning: boolean
    readonly controlClient: unknown
    readonly currentPermissionMode: PermissionModeView
    newSession(resumeSessionId?: string, cwd?: string, options?: { preserveModel?: boolean }): void
    setPermissionMode(mode: PermissionModeView): Promise<boolean>
  }
}

export interface RefreshHooks<E> {
  isAttached(entry: E): boolean
  /** Start the replacement engine ahead of the first prompt, as at activation. */
  prewarm(entry: E): void
  /** Show a conversation's (possibly changed) permission mode in its chat. */
  publishPermissionMode(entry: E): void
}

/** Whether a conversation has nothing to lose: not begun, not busy, not attached. */
export function isUnusedConversation<E extends RefreshableEntry>(entry: E, isAttached: (entry: E) => boolean): boolean {
  return entry.session.transcript.length === 0 && !entry.session.isTurnRunning && !isAttached(entry)
}

/**
 * Apply a saved setting to conversations that have not started. Returns the keys of the
 * conversations it changed.
 *
 * The permission mode is applied to each session directly: a session keeps its own mode
 * across engine restarts, so restarting would not change it. Anything else that applies
 * to new conversations restarts the running, unused engines so they read it.
 */
export async function applySavedSetting<E extends RefreshableEntry>(
  setting: EditableSettingDescriptor,
  value: boolean | string,
  entries: readonly E[],
  hooks: RefreshHooks<E>,
): Promise<string[]> {
  if (setting.key === 'permissionMode') {
    return applyPermissionModeToUnused(entries, permissionModeById(String(value)), hooks)
  }
  return setting.effect === 'newConversations' ? restartUnusedEngines(entries, hooks) : []
}

/** Restart the running engines of unused conversations. Returns their keys. */
export function restartUnusedEngines<E extends RefreshableEntry>(
  entries: readonly E[],
  hooks: Pick<RefreshHooks<E>, 'isAttached' | 'prewarm'>,
): string[] {
  const restarted: string[] = []
  for (const entry of entries) {
    if (entry.session.controlClient === null || !isUnusedConversation(entry, hooks.isAttached)) continue
    // A fresh engine for the same (empty) conversation, on the model it already had.
    entry.session.newSession(undefined, undefined, { preserveModel: true })
    hooks.prewarm(entry)
    restarted.push(entry.key)
  }
  return restarted
}

/**
 * Switch unused conversations to `mode`, running or not. A running engine is switched in
 * place; one that has not started records it and starts in it.
 */
export async function applyPermissionModeToUnused<E extends RefreshableEntry>(
  entries: readonly E[],
  mode: PermissionModeView,
  hooks: Pick<RefreshHooks<E>, 'isAttached' | 'publishPermissionMode'>,
): Promise<string[]> {
  const changed: string[] = []
  for (const entry of entries) {
    if (!isUnusedConversation(entry, hooks.isAttached) || entry.session.currentPermissionMode.id === mode.id) continue
    // A refusal is reported by the session itself; the pill still shows what is enforced.
    if (await entry.session.setPermissionMode(mode)) changed.push(entry.key)
    hooks.publishPermissionMode(entry)
  }
  return changed
}
