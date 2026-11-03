/**
 * The `--rayucode-settings` helper: the extension host asks a short-lived engine child to
 * read or write Rayu's SHARED settings files, because the settings code cannot load in the
 * host (see src/utils/settings/editableSettingsStore.ts).
 *
 * Same shape as the other helper flags: one action as JSON on stdin (never argv), NDJSON
 * frames on stdout, ending with a result frame. A dependency-free leaf, so the host can
 * share the contract without importing the engine entrypoint.
 */

export const SETTINGS_FLAG = '--rayucode-settings'

export type SettingsChildAction =
  | { action: 'read' }
  | { action: 'write'; key: string; value: boolean | string }

export interface SettingsSnapshotFrame {
  type: 'rayucode_settings_snapshot'
  values: {
    autoCompactEnabled: boolean
    language: string
    outputStyle: string
  }
  outputStyles: Array<{ name: string; description?: string }>
}

export interface SettingsResultFrame {
  type: 'rayucode_settings_result'
  ok: boolean
  /** Already user-facing. */
  error?: string
}

export type SettingsChildFrame = SettingsSnapshotFrame | SettingsResultFrame
