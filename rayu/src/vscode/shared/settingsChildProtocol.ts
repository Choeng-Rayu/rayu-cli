/**
 * The `--rayucode-settings` helper: the extension host asks a short-lived engine child to
 * read or write Rayu's SHARED settings files, because the settings code cannot load in the
 * host (see src/utils/settings/editableSettingsStore.ts).
 *
 * Same shape as the other helper flags: one action as JSON on stdin (never argv), NDJSON
 * frames on stdout, ending with a result frame. A dependency-free leaf, so the host can
 * share the contract without importing the engine entrypoint.
 *
 * Besides the Settings tab's read/write, this child also answers the engine-module
 * questions the editor commands need — permission rules, hooks, doctor diagnostics and
 * memory files. Those modules reach config, analytics and the logger, so the host must
 * never import them; the child is the one place that can. Every data frame is plain JSON
 * (no Ink, no functions) so it can cross the process boundary unchanged.
 */

export const SETTINGS_FLAG = '--rayucode-settings'

/** The behaviors a stored permission rule can have. Mirrors PermissionBehavior. */
export type PermissionRuleBehavior = 'allow' | 'deny' | 'ask'

/** An editable settings scope, named the way the editor UI names it. */
export type EditablePermissionSource = 'user' | 'project' | 'local'

/** Where an additional working directory can be persisted. */
export type AdditionalDirectorySource = 'user' | 'project' | 'local'

export type SettingsChildAction =
  | { action: 'read' }
  | { action: 'write'; key: string; value: boolean | string }
  | { action: 'permissions-read' }
  | {
      action: 'permission-add'
      behavior: PermissionRuleBehavior
      rule: string
      source: EditablePermissionSource
    }
  | {
      action: 'permission-remove'
      behavior: PermissionRuleBehavior
      rule: string
      source: EditablePermissionSource
    }
  | { action: 'hooks-read' }
  | { action: 'doctor' }
  | { action: 'memory-list' }
  | { action: 'add-directory'; path: string; source: AdditionalDirectorySource }

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

/** One stored permission rule, already serialized the canonical way. */
export interface PermissionRuleView {
  behavior: PermissionRuleBehavior
  rule: string
  source: EditablePermissionSource
}

export interface PermissionsFrame {
  type: 'rayucode_permissions'
  rules: PermissionRuleView[]
}

/** One settings-file hook. */
export interface HookView {
  event: string
  source: string
  matcher?: string
  /** The hook command's kind, e.g. `command` or `prompt`. */
  kind: string
  /** The command, URL or prompt the hook runs. */
  text: string
}

export interface HooksFrame {
  type: 'rayucode_hooks'
  hooks: HookView[]
}

/**
 * The doctor report, restated as plain JSON so this leaf does not import the engine's
 * doctor module (which reaches execa, the installer and the updater).
 */
export interface DoctorReport {
  installationType: string
  version: string
  installationPath: string
  invokedBinary: string
  configInstallMethod: string
  autoUpdates: string
  hasUpdatePermissions: boolean | null
  multipleInstallations: Array<{ type: string; path: string }>
  warnings: Array<{ issue: string; fix: string }>
  recommendation?: string
  packageManager?: string
  ripgrepStatus: {
    working: boolean
    mode: string
    systemPath: string | null
  }
}

export interface DoctorFrame {
  type: 'rayucode_doctor'
  diagnostic: DoctorReport
}

export type MemoryFileScope =
  | 'user'
  | 'project'
  | 'local'
  | 'managed'
  | 'auto'
  | 'other'

export interface MemoryFileView {
  path: string
  scope: MemoryFileScope
  /** False for the standard files the UI offers to create. */
  exists: boolean
}

export interface MemoryFrame {
  type: 'rayucode_memory'
  files: MemoryFileView[]
}

export type SettingsChildFrame =
  | SettingsSnapshotFrame
  | SettingsResultFrame
  | PermissionsFrame
  | HooksFrame
  | DoctorFrame
  | MemoryFrame

const FRAME_TYPES = new Set([
  'rayucode_settings_snapshot',
  'rayucode_settings_result',
  'rayucode_permissions',
  'rayucode_hooks',
  'rayucode_doctor',
  'rayucode_memory',
])

/**
 * Whether a decoded NDJSON frame is one this protocol defines.
 *
 * Validates the discriminator only: the payload shapes are produced by the child and
 * consumed by the host in the same release, so a deeper check would reject nothing a
 * version-skewed peer would not already have broken on. It does keep an unrecognised
 * frame from being read as data.
 */
export function isSettingsChildFrame(frame: unknown): frame is SettingsChildFrame {
  if (!frame || typeof frame !== 'object') return false
  const { type } = frame as { type?: unknown }
  return typeof type === 'string' && FRAME_TYPES.has(type)
}
