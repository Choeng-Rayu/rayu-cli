import type { Theme } from './theme.js'

/**
 * Per-tool color-coding for the TUI.
 *
 * Maps a tool's stable internal name (`Tool.name`, e.g. `'Bash'`, `'Read'`,
 * `'Grep'`) to a theme color token. The token is used to color the tool-use
 * label in {@link AssistantToolUseMessage} and to tint the tool's result block
 * in {@link UserToolSuccessMessage}, so each category of tool gets a distinct,
 * VS Code-like hue that makes the transcript easy to scan.
 *
 * Tools are grouped by *activity category* rather than one hue per tool, so
 * related tools share a color (e.g. `Grep` + `Glob` + `WebSearch` are all
 * "search"). Uncategorized tools return `undefined` and keep the default text
 * color — no visual change for them.
 *
 * The returned value is a `keyof Theme`; `ThemedText` resolves it against the
 * active theme, so the mapping works across all themes (light/dark, ansi,
 * daltonized) without hardcoding any raw color here.
 */

// Execution — running commands / code.
const EXECUTE_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell', 'REPL'])

// Reading / inspecting existing content.
const READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'LSP'])

// Searching / discovery across the codebase, tools, or the web.
const SEARCH_TOOLS: ReadonlySet<string> = new Set([
  'Grep',
  'Glob',
  'WebSearch',
  'ToolSearch',
  'ListMcpResourcesTool',
])

// Mutating files / editor state.
const EDIT_TOOLS: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'NotebookEdit',
  'TodoWrite',
])

// Web / generative — external content and media.
const WEB_TOOLS: ReadonlySet<string> = new Set([
  'WebFetch',
  'GenerateImage',
  'GenerateVideo',
])

// Orchestration — sub-agents, tasks, teams, skills.
const TASK_TOOLS: ReadonlySet<string> = new Set([
  'Agent',
  'Task', // legacy alias for Agent
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'Skill',
  'InstallSkill',
])

/**
 * Resolve the foreground color token for a tool's category.
 *
 * @param toolName The tool's stable internal `name` (not the user-facing
 *   label, which can vary with input).
 * @returns A {@link Theme} color key, or `undefined` to keep the default text
 *   color for uncategorized/empty tools.
 */
export function getToolNameColor(
  toolName: string | undefined,
): keyof Theme | undefined {
  if (!toolName) return undefined
  if (EXECUTE_TOOLS.has(toolName)) return 'toolExecute'
  if (READ_TOOLS.has(toolName)) return 'toolRead'
  if (SEARCH_TOOLS.has(toolName)) return 'toolSearch'
  if (EDIT_TOOLS.has(toolName)) return 'toolEdit'
  if (WEB_TOOLS.has(toolName)) return 'toolWeb'
  if (TASK_TOOLS.has(toolName)) return 'toolTask'
  return undefined
}
