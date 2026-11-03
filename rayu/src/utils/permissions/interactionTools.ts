/**
 * Tools whose "permission" is really a form.
 *
 * The decision only means anything when it carries the filled-in input
 * (AskUserQuestion `answers`, ExitPlanMode plan approval, ReviewArtifact `selected`).
 * Persisting an allow rule for one of these would auto-approve every future call
 * with an EMPTY payload — silently breaking it even in the terminal — so no remote
 * surface may offer or apply "always allow" for them.
 *
 * Lives here rather than with any one remote so every surface reads the same list:
 * the Telegram bridge and the Web Bridge both enforce it, and the Web Bridge also
 * runs inside the VS Code extension host, which must not import Telegram code.
 */

import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/AskUserQuestionTool/prompt.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from '../../tools/ExitPlanModeTool/constants.js'

const INTERACTION_TOOLS = new Set<string>([
  ASK_USER_QUESTION_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  'ReviewArtifact',
])

export function isInteractionTool(toolName: string): boolean {
  return INTERACTION_TOOLS.has(toolName)
}
