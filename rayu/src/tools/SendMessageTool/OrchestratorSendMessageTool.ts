/**
 * SendMessage for Orchestrator mode: continue one of the session's own workers.
 *
 * The full SendMessage tool belongs to agent teams and is disabled without them
 * (`isAgentSwarmsEnabled()`). Orchestrator mode still needs its core: sending a fix to
 * the worker that owns the files, or answering a running worker, keeps that worker's
 * context instead of briefing a replacement from nothing. This variant offers exactly
 * that: plain text to an in-process worker of this session, addressed by the name given
 * in its Agent call or by its agent ID. Broadcast, other sessions, teammate mailboxes and
 * protocol messages (shutdown, plan approval) cannot be reached from it, so it can
 * neither end the session nor send anything off the machine.
 *
 * `getTools` adds it for the main thread in Orchestrator mode when the full tool is not
 * enabled (src/tools.ts); worker tool pools are built under the worker's own mode and
 * never include it. It is not deferred: an Orchestrator session may have no ToolSearch
 * to load a deferred tool with.
 */
import { z } from 'zod/v4'
import type { AppState } from '../../state/AppState.js'
import { buildTool, type Tool, type ToolDef } from '../../Tool.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isMainSessionTask } from '../../tasks/LocalMainSessionTask.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { parseAddress } from '../../utils/peerAddress.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { SEND_MESSAGE_TOOL_NAME } from './constants.js'
import {
  type MessageOutput,
  messageLocalAgent,
  resolveLocalAgentRecipient,
  SendMessageTool,
} from './SendMessageTool.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.object({
    to: z
      .string()
      .describe(
        'The worker: the `name` you gave it in its Agent call, or the agentId from its launch result',
      ),
    summary: z
      .string()
      .optional()
      .describe('A 5-10 word summary shown as a preview in the UI'),
    message: z
      .string()
      .describe(
        'What the worker should do next. It sees only this message and its own earlier work, so name the files, the exact problem and how to check the result.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

/**
 * Why `to` cannot be messaged from Orchestrator mode, or null when it can.
 *
 * An ID that is not in state any more is accepted: the delivery then resumes the
 * worker from its transcript, and reports plainly if there is none.
 */
export function orchestratorRecipientProblem(
  to: string,
  appState: Pick<AppState, 'agentNameRegistry' | 'tasks'>,
): string | null {
  if (to.trim().length === 0) return 'to must name one of your workers.'
  if (to === '*') {
    return 'Broadcast is not available in Orchestrator mode. Message one worker at a time, by its name or agentId.'
  }
  if (parseAddress(to).scheme !== 'other') {
    return 'Only workers launched in this session can be messaged in Orchestrator mode; other sessions are not reachable.'
  }
  const agentId = resolveLocalAgentRecipient(to, appState)
  if (!agentId) {
    return `No worker is named "${to}". Use the name from the worker's Agent call, or the agentId from its launch result.`
  }
  const task = appState.tasks[agentId]
  if (task !== undefined && (!isLocalAgentTask(task) || isMainSessionTask(task))) {
    return `"${to}" is not one of your background workers.`
  }
  return null
}

export function getOrchestratorSendMessagePrompt(): string {
  return `
# SendMessage

Send a follow-up to one of your own background workers: an agent you launched with the Agent tool in this session.

\`\`\`json
{"to": "api", "summary": "use the shared field name", "message": "fetchUser in src/api/userApi.ts must return displayName, the field the User type in src/types/user.ts declares, not fullName. Change it and rerun the tests for src/api."}
\`\`\`

- \`to\` is the \`name\` you gave the worker in its Agent call, or the agentId from its launch result.
- A running worker receives the message at its next tool round.
- A finished or stopped worker is resumed in the background with its earlier context, and you are notified when it finishes, as for a new worker.
- The worker sees only this message and its own earlier work, not this conversation: name the files, the exact problem and how to check the fix.

Use it to send a fix to the worker that owns the files, or to answer a worker's question, instead of briefing a replacement. Broadcast, other sessions and protocol messages are not available here.
`.trim()
}

export const OrchestratorSendMessageTool: Tool<InputSchema, MessageOutput> =
  buildTool({
    name: SEND_MESSAGE_TOOL_NAME,
    searchHint: 'send a follow-up to one of your background workers',
    maxResultSizeChars: 100_000,

    userFacingName() {
      return 'SendMessage'
    },

    get inputSchema(): InputSchema {
      return inputSchema()
    },
    shouldDefer: false,

    // Offered only where getTools adds it.
    isEnabled() {
      return true
    },

    isReadOnly() {
      return true
    },

    backfillObservableInput: SendMessageTool.backfillObservableInput,

    toAutoClassifierInput(input) {
      return `to ${input.to}: ${input.message}`
    },

    async checkPermissions(input) {
      return { behavior: 'allow' as const, updatedInput: input }
    },

    async validateInput(input, context) {
      const problem = orchestratorRecipientProblem(input.to, context.getAppState())
      if (problem) return { result: false, message: problem, errorCode: 9 }
      return { result: true }
    },

    async description() {
      return 'Send a follow-up message to one of your background workers'
    },

    async prompt() {
      return getOrchestratorSendMessagePrompt()
    },

    mapToolResultToToolResultBlockParam(data, toolUseID) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: [{ type: 'text' as const, text: jsonStringify(data) }],
      }
    },

    async call(input, context, canUseTool, assistantMessage) {
      // Checked again: the worker may have changed since validateInput ran.
      const appState = context.getAppState()
      const problem = orchestratorRecipientProblem(input.to, appState)
      const agentId = resolveLocalAgentRecipient(input.to, appState)
      if (problem || !agentId) {
        return { data: { success: false, message: problem ?? `No worker is named "${input.to}".` } }
      }
      return messageLocalAgent({
        agentId,
        to: input.to,
        message: input.message,
        context,
        canUseTool,
        assistantMessage,
      })
    },

    renderToolUseMessage,
    renderToolResultMessage,
  } satisfies ToolDef<InputSchema, MessageOutput>)
