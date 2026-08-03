/**
 * Tool adapter — maps RAYU `Tool`s onto MCP tool definitions.
 *
 * The RAYU → MCP mapping itself already exists in `src/entrypoints/mcp.ts`
 * (`startMCPServer`); this module adds the piece that was missing for
 * plug-in-to-a-host use: an explicit **capability boundary**. `getTools()`
 * returns everything the TUI can drive, including tools that are only
 * meaningful inside a live RAYU session (plan mode, worktrees, the todo list,
 * teammate messaging). Exposing those to Claude Code / Codex would hand the
 * host tools that either no-op or mutate state nobody is reading.
 *
 * The boundary is an **allowlist**: unknown/new tools are hidden by default so
 * adding a session-coupled tool to `src/tools.ts` cannot silently widen RAYU's
 * MCP surface. A denylist is kept alongside it purely as documentation of
 * *why* specific tools are out.
 */

import { toolMatchesName, type Tool, type Tools } from '../../Tool.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../../tools/GrepTool/prompt.js'
import { IMAGE_GEN_TOOL_NAME } from '../../tools/ImageGenTool/constants.js'
import { LSP_TOOL_NAME } from '../../tools/LSPTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../../tools/NotebookEditTool/constants.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { SKILL_TOOL_NAME } from '../../tools/SkillTool/constants.js'
import { VIDEO_GEN_TOOL_NAME } from '../../tools/VideoGenTool/constants.js'
import { WEB_FETCH_TOOL_NAME } from '../../tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from '../../tools/WebSearchTool/prompt.js'

/** `InstallSkill` — inlined rather than imported so this module stays cheap. */
const INSTALL_SKILL_TOOL_NAME = 'InstallSkill'

/**
 * Tools RAYU exposes to a host agent over MCP.
 *
 * Every entry must be safe to run in a fresh, non-interactive process with no
 * TUI, no message history, and no live session state.
 */
export const MCP_EXPOSED_TOOL_NAMES: readonly string[] = [
  // File operations
  FILE_READ_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  // Execution
  BASH_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  // Web
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  // Media (billing-gated inside the tool itself — see authGate.ts)
  IMAGE_GEN_TOOL_NAME,
  VIDEO_GEN_TOOL_NAME,
  // RAYU-specific value-add: skills and multi-provider sub-agents
  SKILL_TOOL_NAME,
  INSTALL_SKILL_TOOL_NAME,
  AGENT_TOOL_NAME,
  // Code intelligence (only enabled when ENABLE_LSP_TOOL is set)
  LSP_TOOL_NAME,
]

/**
 * Why each excluded family stays out. Purely documentary — enforcement comes
 * from `MCP_EXPOSED_TOOL_NAMES` being an allowlist — but it keeps the rationale
 * next to the decision so the next person doesn't "fix" the omission.
 */
export const MCP_EXCLUDED_TOOL_REASONS: Readonly<Record<string, string>> = {
  EnterPlanMode: 'plan mode is a RAYU main-loop abstraction; the host has its own',
  ExitPlanMode: 'plan mode is a RAYU main-loop abstraction; the host has its own',
  EnterWorktree: 'mutates the RAYU session cwd, which no host observes',
  ExitWorktree: 'mutates the RAYU session cwd, which no host observes',
  TodoWrite: 'writes to session-scoped todo state the host never renders',
  TaskCreate: 'task state lives in the RAYU main loop',
  TaskGet: 'task state lives in the RAYU main loop',
  TaskUpdate: 'task state lives in the RAYU main loop',
  TaskList: 'task state lives in the RAYU main loop',
  TaskStop: 'task state lives in the RAYU main loop',
  TaskOutput: 'task state lives in the RAYU main loop',
  AskUserQuestion: 'renders an Ink picker; the host owns user interaction',
  SendMessage: 'teammate messaging requires a live swarm session',
  TeamCreate: 'teammate lifecycle requires a live swarm session',
  TeamDelete: 'teammate lifecycle requires a live swarm session',
  ToolSearch: "meta-tool for RAYU's own deferred-tool loading",
  Brief: 'session summary surface with no host equivalent',
  TestingPermission: 'test-only fixture tool',
  Config: 'would let a host rewrite RAYU config without user sight',
  Tungsten: 'singleton virtual terminal that conflicts across agents',
}

/**
 * Filters a RAYU tool list down to the host-safe MCP surface.
 *
 * Uses `toolMatchesName` (not `tool.name ===`) so alias-bearing tools such as
 * `Agent`/`Task` resolve the same way they do in the permission layer.
 */
export function filterToolsForMcp(tools: Tools): Tools {
  return tools.filter(tool =>
    MCP_EXPOSED_TOOL_NAMES.some(name => toolMatchesName(tool, name)),
  )
}

/** Whether a given tool name is part of RAYU's MCP surface. */
export function isToolExposedOverMcp(toolName: string): boolean {
  return MCP_EXPOSED_TOOL_NAMES.includes(toolName)
}

/**
 * Resolves a tool the host asked for, rejecting anything outside the boundary.
 *
 * Returning `undefined` for a tool that exists but is not exposed (rather than
 * falling through to a generic "not found") keeps the failure honest: the tool
 * is real, RAYU is deliberately not offering it here.
 */
export function findExposedTool(tools: Tools, name: string): Tool | undefined {
  if (!isToolExposedOverMcp(name)) return undefined
  return tools.find(tool => toolMatchesName(tool, name))
}
