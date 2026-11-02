/**
 * Routing predicates for host→webview messages.
 *
 * ── WHY THIS IS ITS OWN MODULE AND IMPORTS NOTHING ─────────────────────────────
 *
 * "Does this message belong to one session or to the whole window?" is a decision that
 * must be identical whether the host is pushing to the sidebar or to a tab. Keeping it
 * as a pure predicate — no `vscode`, no state — means it is unit-testable and cannot
 * quietly drift between the two paths.
 *
 * ── GLOBAL MEANS: NO PER-SESSION MEANING ───────────────────────────────────────
 *
 * These describe the window, not a conversation: the sessions lists, the editor's
 * selection, provider setup, and the command-driven model chooser. Attachment state
 * is projected for its owning session. Every other host→webview message is a
 * per-session push and goes through `postToSession`.
 *
 * `init` is deliberately NOT here: it is never broadcast. A full snapshot is sent to a
 * specific surface via `syncSession`/`syncSidebar`, because a panel must receive the
 * state for ITS key, not the globally-active one.
 */
import type { HostToWebviewMessage } from '../../shared/webviewProtocol.js'

/** Messages with no per-session meaning — they go to every surface. */
export const GLOBAL_MESSAGE_TYPES: ReadonlySet<HostToWebviewMessage['type']> = new Set([
  'setSessions',
  'setLiveSessions',
  'setIdeContext',
  'setProviderSetup',
  'setModelChooser',
])

export function isGlobalMessage(type: HostToWebviewMessage['type']): boolean {
  return GLOBAL_MESSAGE_TYPES.has(type)
}

export type SessionRoute = 'sidebar' | 'adopt' | 'tab'

/**
 * Decide where an open conversation should be shown.
 *
 * 'sidebar' — it is the sidebar's conversation: reveal the sidebar.
 * 'adopt'   — the sidebar slot is empty: move it into the sidebar.
 * 'tab'     — the sidebar is occupied: open/focus its editor tab.
 *
 * Pure, like the rest of this module, so the "one conversation, one surface"
 * rule stays identical on every path that opens a conversation.
 */
export function routeForSession(key: string, sidebarKey: string): SessionRoute {
  if (key !== '' && key === sidebarKey) return 'sidebar'
  return sidebarKey === '' ? 'adopt' : 'tab'
}
