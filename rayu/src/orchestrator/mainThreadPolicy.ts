/**
 * Orchestrator mode's hard rule for the main agent: it does not edit files with the
 * file-editing tools itself.
 *
 * The role reminder (reminder.ts) asks for this; this module enforces it. A coordinator
 * that patches files while its workers own them produces exactly the mismatches the mode
 * exists to prevent, and the change belongs to no worker's packet. The rule covers the
 * main thread only: workers run under the same mode and keep its auto-approval.
 *
 * Denied: Edit, Write (except to the session plan file) and NotebookEdit. Shell commands
 * are allowed for the main agent; the shell tool's own permission checks still apply.
 * Because a shell command can also change files, this rule no longer guarantees that the
 * main agent changes nothing — it stops the file-editing tools, and shell access is the
 * user's explicit choice.
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

const FILE_WRITING_TOOLS: ReadonlySet<string> = new Set([
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
])

type PolicyTool = Pick<Tool, 'name'>

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

/** What the call would do that the main agent may not, or null when the rule allows it. */
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
  return null
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
    message: `Orchestrator mode: the main agent coordinates and does not ${change} itself. Delegate this to a \`${GENERAL_PURPOSE_AGENT_TYPE}\` worker with the ${AGENT_TOOL_NAME} tool, naming the files it owns${existingWorker}. Reading files and running shell commands are still available to you.`,
    decisionReason: { type: 'mode', mode: 'orchestrator' },
  }
}
