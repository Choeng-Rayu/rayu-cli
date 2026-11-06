/**
 * Which host spawned this engine process.
 *
 * `src/entrypoints/vscodeHost.ts` marks the engine child it runs with
 * `markEditorHostedEngine()`. It is the ONE way the engine can tell "I am the editor's
 * long-lived conversation engine" apart from "I am a one-shot `rayu -p` run" — both are
 * headless, both speak stream-json, and neither passes a flag that distinguishes them.
 *
 * That distinction matters for integrations that should only be adopted by the editor:
 * see `src/telegram/telegramStart.ts`, where a headless engine may start the Telegram
 * bridge for the conversation the chat is attached to. A scripted `-p` run in the same
 * directory must not become that bridge (it would be drivable from the chat and would
 * push its output there).
 *
 * ── A MODULE FLAG, NOT AN ENVIRONMENT VARIABLE ─────────────────────────────────
 *
 * The obvious implementation — an env var set by the entrypoint — is wrong here. Every
 * tool the engine runs inherits the engine's environment, so a `Bash` call that starts
 * another `rayu` would hand the marker to a process the editor did not spawn. The
 * memory watchdog's knob has the same hazard and solves it by deleting the variable as
 * soon as it is read (see `utils/engineMemoryWatchdog.ts`); a flag has no such window.
 *
 * Both files are bundled into the same `engine.mjs`, so they share this module's state.
 *
 * Dependency-free: `vscodeHost.ts` imports it at module load, before any engine setup.
 */

let editorHosted = false

/** Called by the editor's engine entrypoint, before a session starts. */
export function markEditorHostedEngine(): void {
  editorHosted = true
}

/** True when this process is the Rayucode VS Code extension's engine. */
export function isEditorHostedEngine(): boolean {
  return editorHosted
}

/** Test helper: forget the mark so cases cannot leak into one another. */
export function resetEditorHostedEngine(): void {
  editorHosted = false
}
