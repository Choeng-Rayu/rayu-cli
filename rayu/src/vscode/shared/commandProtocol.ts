/**
 * Types for the command registry protocol (`IPC_COMMAND_REGISTRY`).
 *
 * The CLI sends a `CommandRegistry` when the extension attaches, so the panel
 * can render the command palette dynamically rather than hard-coding buttons.
 *
 * ── WHY COMMANDS ARE DESCRIBED HERE, NOT IN src/commands.ts ─────────────────────
 *
 * `src/commands.ts` is shared engine code that runs in both the CLI and the VS
 * Code engine child.  Adding VS Code–specific presentation metadata there would
 * couple the terminal CLI to the extension panel.  This file contains ONLY the
 * wire shape that crosses the IPC boundary; the CLI's `commandRegistry.ts`
 * (in `src/vscode/panel/`) builds it from the engine's command list.
 *
 * ── DEPENDENCY CONSTRAINT ──────────────────────────────────────────────────────
 *
 * Nothing may be imported here — same rule as the other `shared/` files.
 */

/**
 * Grouping categories for the command palette.
 *
 * The order here is the display order in the panel.
 */
export type CommandCategory =
  | 'file_operations'
  | 'conversation'
  | 'mcp'
  | 'tasks'
  | 'settings'
  | 'debug'
  | 'advanced'

/** Metadata for one CLI command, as sent to the extension panel. */
export interface CommandMetadata {
  /** The slash-command name, e.g. `"model"` (without the leading `/`). */
  name: string
  /** User-visible label, e.g. `"Change Model"`. */
  displayName: string
  /** One-line description shown in the palette. */
  description: string
  category: CommandCategory
  /** VS Code Codicon id, e.g. `"$(gear)"`.  Optional. */
  icon?: string
  /** Key combination string, e.g. `"Ctrl+M"`.  Optional. */
  keybinding?: string
  /** False for commands that work in the session-less welcome screen. */
  requiresSession: boolean
  /** True for commands that require the user to be signed in. */
  requiresAuth: boolean
  /** True for commands that require a paid plan. */
  isPaid: boolean
  /** Whether the command is currently enabled (feature flags, plan gate, etc.). */
  isEnabled: boolean
}

/**
 * The full registry sent on `IPC_COMMAND_REGISTRY`.
 *
 * `version` lets the receiver detect an incompatible shape from an older CLI.
 */
export interface CommandRegistry {
  version: 1
  commands: CommandMetadata[]
}
