/**
 * Module-level handle on the main thread's in-flight turn.
 *
 * The REPL owns the turn's AbortController in React state, so only the REPL (or
 * a hook it hands the ref to, like useReplBridge) could ever interrupt it. A
 * remote client — the Telegram bridge — has no such access: it runs from the
 * poll loop, outside React.
 *
 * `executeUserInput` publishes each turn's controller here so any caller can
 * request the same cancellation Esc performs, without threading a ref through
 * the component tree.
 *
 * The default reason is 'interrupt', matching what the CCR bridge uses for a
 * remote stop: `isUserInitiatedAbort` still counts it as a genuine user
 * interrupt (so the turn is labelled as interrupted, not as a system failure),
 * but it is NOT 'user-cancel', so the REPL's auto-restore does not rewind the
 * conversation and paste the remote prompt into the local input box.
 */

let activeController: AbortController | null = null

/** Called by the turn runner. Pass null when the turn is over. */
export function publishActiveTurn(controller: AbortController | null): void {
  activeController = controller
}

/** True when a turn is running and has not already been aborted. */
export function isTurnInterruptible(): boolean {
  return activeController !== null && !activeController.signal.aborted
}

/**
 * Abort the in-flight turn. Returns false when there was nothing to stop, so
 * callers can tell the user "nothing is running" instead of lying.
 */
export function interruptActiveTurn(reason = 'interrupt'): boolean {
  const controller = activeController
  if (!controller || controller.signal.aborted) return false
  controller.abort(reason)
  activeController = null
  return true
}

/** Test helper. */
export function resetActiveTurn(): void {
  activeController = null
}
