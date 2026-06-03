/**
 * Module-level remote model override — set by the Telegram bridge when the user
 * switches models from their phone. Cleared when the CLI's own /model command runs.
 *
 * Uses a plain signal + variable (not React state) so that telegramConnect.ts
 * (a non-React module) can trigger a re-render in useMainLoopModel via
 * useSyncExternalStore without introducing circular imports.
 */
import { createSignal } from './signal.js'

let _override: string | null = null
const _signal = createSignal()

/** Set the remote model override and notify React subscribers (triggers re-render). */
export function setRemoteModelOverride(model: string): void {
  _override = model
  _signal.emit()
}

/** Clear the remote override — call this when the CLI's /model command runs. */
export function clearRemoteModelOverride(): void {
  if (_override === null) return
  _override = null
  _signal.emit()
}

/** Snapshot getter — compatible with useSyncExternalStore. */
export function getRemoteModelOverride(): string | null {
  return _override
}

/** Subscribe to changes — compatible with useSyncExternalStore. */
export const subscribeToRemoteModelOverride = _signal.subscribe
