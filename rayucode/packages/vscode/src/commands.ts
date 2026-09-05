// Contributed command ids — single source of truth.
//
// These ids appear in three places that must agree: `contributes.commands` in
// package.json, the `registerCommand` calls in extension.ts, and the click targets
// the status bar points at. A drifting literal fails only at runtime (a menu entry
// that does nothing, or a status bar click that silently no-ops), so they are
// declared once here and imported everywhere — including by the packaging test,
// which pins the manifest against these exact values.
//
// The three selection-intent commands live with the provider that raises them
// (see `codeActions.ts`), which is their only other consumer.

/** Reveal/open the Agent_Panel for the active workspace (R14.1). */
export const OPEN_PANEL_COMMAND = "rayucode.openPanel";

/** Stage the active selection into the panel prompt input (R9.5). */
export const ADD_SELECTION_COMMAND = "rayucode.addSelectionToPrompt";

/** Interrupt the in-progress turn (R3.6) — the status bar's busy click target. */
export const INTERRUPT_COMMAND = "rayucode.interrupt";

/** Start a fresh, independent session (R12.4). */
export const NEW_SESSION_COMMAND = "rayucode.newSession";
