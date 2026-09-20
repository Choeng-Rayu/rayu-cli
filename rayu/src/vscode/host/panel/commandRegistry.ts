/**
 * Build the command registry payload for `IPC_COMMAND_REGISTRY`.
 *
 * Maps the CLI's slash-command list onto `CommandMetadata[]` for the panel's
 * command palette.  The CLI's own command objects do not carry every panel
 * field (category, icon, isPaid, etc.) — this module enriches them with a
 * best-effort static mapping while staying forward-compatible: unknown names
 * fall through to the `advanced` category so new commands are visible rather
 * than silently dropped.
 *
 * ── WHERE THIS RUNS ────────────────────────────────────────────────────────────
 *
 * Called from `useRayucodeTaskBridge`'s `IPC_COMMAND_REGISTRY` handler, which
 * runs inside the CLI's own process.  `getCommands()` is therefore local and
 * cheap — no IPC needed to retrieve the list.
 */
import type { CommandCategory, CommandMetadata, CommandRegistry } from '../../shared/commandProtocol.js'
import { getOriginalCwd } from '../../../bootstrap/state.js'

/**
 * Build and return the command registry for the current session.
 *
 * `cwd` defaults to `getOriginalCwd()` so the caller does not need to thread
 * it through, matching the pattern used by `useRayucodeTaskBridge`.
 */
export async function buildCommandRegistry(cwd?: string): Promise<CommandRegistry> {
  // Dynamic import keeps `getCommands` and its graph out of the extension
  // host bundle (this file runs in the CLI process, but just in case).
  const { getCommands } = await import('../../../commands.js')
  const commands = await getCommands(cwd ?? getOriginalCwd())

  return {
    version: 1,
    commands: commands.map(cmd => toCommandMetadata(cmd)),
  }
}

// ── Category heuristics ────────────────────────────────────────────────────────

/**
 * Known command names → category, for the most important commands.
 *
 * Everything else falls through to `'advanced'` so the palette is complete.
 */
const CATEGORY_MAP: Record<string, CommandCategory> = {
  // File operations
  read: 'file_operations',
  write: 'file_operations',
  edit: 'file_operations',
  glob: 'file_operations',
  grep: 'file_operations',
  diff: 'file_operations',
  // Conversation
  clear: 'conversation',
  compact: 'conversation',
  context: 'conversation',
  export: 'conversation',
  summary: 'conversation',
  undo: 'conversation',
  // MCP
  mcp: 'mcp',
  'mcp-list': 'mcp',
  'mcp-resources': 'mcp',
  // Tasks
  task: 'tasks',
  tasks: 'tasks',
  todo: 'tasks',
  'todo-write': 'tasks',
  plan: 'tasks',
  // Settings
  model: 'settings',
  config: 'settings',
  connect: 'settings',
  permissions: 'settings',
  effort: 'settings',
  thinking: 'settings',
  // Debug
  status: 'debug',
  sessions: 'debug',
  logs: 'debug',
}

/**
 * Known command names → VS Code Codicon id.
 *
 * Unmapped commands get no icon.
 */
const ICON_MAP: Record<string, string> = {
  read: '$(file)',
  write: '$(pencil)',
  edit: '$(edit)',
  glob: '$(search)',
  grep: '$(search-fuzzy)',
  model: '$(hubot)',
  config: '$(gear)',
  connect: '$(plug)',
  mcp: '$(extensions)',
  tasks: '$(checklist)',
  task: '$(add)',
  plan: '$(project)',
  clear: '$(trash)',
  compact: '$(fold-down)',
  status: '$(info)',
  sessions: '$(list-unordered)',
  diff: '$(diff)',
  permissions: '$(shield)',
  effort: '$(dashboard)',
  thinking: '$(lightbulb)',
}

// ── Wire-format builder ────────────────────────────────────────────────────────

type RawCommand = {
  name: string
  description?: string
  aliases?: string[]
  userFacingName?: string | (() => string)
}

function toCommandMetadata(cmd: RawCommand): CommandMetadata {
  const name = cmd.name
  const category: CommandCategory = CATEGORY_MAP[name] ?? 'advanced'
  const icon = ICON_MAP[name]

  const displayName =
    typeof cmd.userFacingName === 'function'
      ? cmd.userFacingName()
      : (cmd.userFacingName ?? titleCase(name))

  return {
    name,
    displayName,
    description: cmd.description ?? '',
    category,
    icon,
    requiresSession: true,
    requiresAuth: false,
    isPaid: false,
    isEnabled: true,
  }
}

function titleCase(name: string): string {
  return name
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}
