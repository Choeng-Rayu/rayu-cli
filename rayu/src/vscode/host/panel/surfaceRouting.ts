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
  'setTelegramConnect',
  'setModelChooser',
])

export function isGlobalMessage(type: HostToWebviewMessage['type']): boolean {
  return GLOBAL_MESSAGE_TYPES.has(type)
}
