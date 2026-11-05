/**
 * The editor's engine-backed commands: `/permissions`, `/memory`, `/doctor`, `/status`,
 * `/hooks`, `/add-dir` and `/export`.
 *
 * They run in the extension host, but every question that needs engine code — permission
 * rules, hooks, the doctor report, memory discovery, settings writes — travels through
 * the `--rayucode-settings` child (`host/settings/engineChildAction.ts`). Nothing here
 * statically imports `src/utils/permissions`, `src/utils/hooks`, `src/utils/claudemd`,
 * `src/utils/doctorDiagnostic` or `src/commands`; those reach config, analytics and the
 * logger, which the host bundle cannot carry.
 *
 * The UI is VS Code's own: QuickPick, InputBox, file dialogs, and read-only Markdown
 * documents for the reports.
 */
import type { EngineLaunch } from '../engine/engineLaunch.js'

export interface HostCommandContext {
  launch: EngineLaunch
  /** Workspace folder, else the engine cwd. Settings scopes resolve from here. */
  cwd: string
  /** Restart the current conversation's engine with resume (used after /add-dir and permission edits). */
  restartConversation(): Promise<void>
}

export interface StatusFacts {
  extensionVersion: string
  model: string | null
  provider: string | null
  cwd: string
  sessionId: string | null
  permissionMode: string
  signedIn: boolean
  account: string | null
  mcpServers: ReadonlyArray<{ name: string; status: string }>
}

export { runPermissionsCommand } from './permissions.js'
export { runMemoryCommand } from './memory.js'
export { runDoctorCommand } from './doctor.js'
export { runHooksCommand } from './hooks.js'
export { runAddDirectoryCommand } from './addDir.js'
export { runStatusCommand } from './status.js'
export { statusMarkdown } from './statusFormat.js'
export { runExportCommand } from './export.js'
export { transcriptToMarkdown, defaultExportName } from './exportFormat.js'
