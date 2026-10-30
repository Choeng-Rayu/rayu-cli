/**
 * Orchestrator mode's hard rule for the main agent: it does not change files itself.
 *
 * The role reminder (reminder.ts) asks for this; this module enforces it. A coordinator
 * that patches files while its workers own them produces exactly the mismatches the mode
 * exists to prevent, and the change belongs to no worker's packet. The rule covers the
 * main thread only: workers run under the same mode and keep its auto-approval.
 *
 * Denied: Edit and Write (except to the session plan file), NotebookEdit, and shell
 * commands that the shell tool does not classify as read-only. PowerShell's synchronous
 * classification is conservative and may deny a harmless command; that is the safe
 * direction, and the denial says what to do instead.
 *
 * Checked before Orchestrator's allow-everything step (hasPermissionsToUseToolInner)
 * and on the PreToolUse-hook allow path (checkRuleBasedPermissions), so neither the
 * mode nor a hook lets the main thread through.
 */
import type { Tool, ToolUseContext } from '../Tool.js'
import {
  AGENT_TOOL_NAME,
  GENERAL_PURPOSE_AGENT_TYPE,
} from '../tools/AgentTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../tools/NotebookEditTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from '../tools/SendMessageTool/constants.js'
import type { PermissionDenyDecision } from '../types/permissions.js'
import { expandPath } from '../utils/path.js'
import { isSessionPlanFile } from '../utils/plans.js'
import { SHELL_TOOL_NAMES } from '../utils/shell/shellToolUtils.js'

const FILE_WRITING_TOOLS: ReadonlySet<string> = new Set([
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
])

type PolicyTool = Pick<Tool, 'name' | 'inputSchema' | 'isReadOnly'>

type PolicyContext = Pick<ToolUseContext, 'agentId' | 'getAppState'> & {
  options: Pick<ToolUseContext['options'], 'tools'>
}

/** The denial due for this call, or null when the main-thread rule does not apply. */
export function orchestratorMainThreadDenial(
  tool: PolicyTool,
  input: Record<string, unknown>,
  context: PolicyContext,
): PermissionDenyDecision | null {
  if (context.agentId) return null
  if (context.getAppState().toolPermissionContext.mode !== 'orchestrator') {
    return null
  }
  const change = describeChange(tool, input)
  return change ? denial(change, context) : null
}

/** What the call would do that the main agent may not, or null for a read-only call. */
function describeChange(
  tool: PolicyTool,
  input: Record<string, unknown>,
): string | null {
  if (FILE_WRITING_TOOLS.has(tool.name)) {
    const path = typeof input.file_path === 'string' ? input.file_path : ''
    if (path && isSessionPlanFile(expandPath(path))) return null
    return 'edit files'
  }
  if (tool.name === NOTEBOOK_EDIT_TOOL_NAME) return 'edit files'
  if (SHELL_TOOL_NAMES.includes(tool.name) && !isReadOnlyCall(tool, input)) {
    return 'run commands that can change files or state'
  }
  return null
}

/** Input the schema rejects is treated as not read-only: the safe answer. */
function isReadOnlyCall(tool: PolicyTool, input: Record<string, unknown>): boolean {
  const parsed = tool.inputSchema.safeParse(input)
  return parsed.success && tool.isReadOnly(parsed.data)
}

function denial(change: string, context: PolicyContext): PermissionDenyDecision {
  const canMessage = context.options.tools.some(
    tool => tool.name === SEND_MESSAGE_TOOL_NAME,
  )
  const existingWorker = canMessage
    ? `, or send it with ${SEND_MESSAGE_TOOL_NAME} to the worker that already owns those files`
    : ''
  return {
    behavior: 'deny',
    message: `Orchestrator mode: the main agent coordinates and does not ${change} itself. Delegate this to a \`${GENERAL_PURPOSE_AGENT_TYPE}\` worker with the ${AGENT_TOOL_NAME} tool, naming the files it owns${existingWorker}. Read-only tools and commands are still available to you.`,
    decisionReason: { type: 'mode', mode: 'orchestrator' },
  }
}
