/**
 * Claude Code's `stream-json` surface.
 *
 * Unlike Codex, Claude Code is not JSON-RPC. With
 * `--input-format stream-json --output-format stream-json` it reads and writes
 * newline-delimited *message envelopes*: there is no request/response
 * correlation, no server-initiated requests, and no ids to match. Input is a
 * user message; output is a stream of system / assistant / user / result
 * envelopes.
 *
 * The CLI flags below are verified against the official CLI reference. The
 * envelope field names follow the documented Agent SDK output format, and the
 * normalizer reads them **defensively** — an envelope shape that drifts should
 * degrade to "no events", never crash a running agent.
 *
 * ## The steering consequence
 *
 * The reference states that with `--input-format stream-json`, a message sent
 * while Claude is working **stays queued and runs as its own turn**. So writing
 * to stdin mid-turn is always safe, but it is *queueing*, not steering — there is
 * no way to alter an in-flight turn. `ClaudeCodeAdapter` therefore declares no
 * `steer` method, which makes admission control choose `queue`.
 */

import { randomUUID } from 'crypto'

/** `type` values RAYU understands on the output stream. */
export const CLAUDE_MESSAGE_TYPE = {
  system: 'system',
  assistant: 'assistant',
  user: 'user',
  result: 'result',
  /** Only present with `--include-partial-messages`. */
  streamEvent: 'stream_event',
} as const

/** `result.subtype` values. Anything starting `error` is a failure. */
export const CLAUDE_RESULT_SUCCESS = 'success'

/**
 * Content block types inside an assistant message.
 *
 * `thinking` is surfaced separately from `text` so the UI can style or suppress
 * it, matching how Codex reasoning is handled.
 */
export const CLAUDE_BLOCK = {
  text: 'text',
  thinking: 'thinking',
  toolUse: 'tool_use',
  toolResult: 'tool_result',
} as const

/**
 * Tool names whose use implies a file mutation.
 *
 * Claude Code reports edits as ordinary tool calls rather than as a dedicated
 * file-change event, so the only way to populate `changedFiles` — which the
 * Workspace Manager needs for conflict detection — is to recognize the tools
 * that write. Read-only tools are deliberately excluded.
 */
export const CLAUDE_FILE_WRITING_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
])

export type ClaudeContentBlock = {
  type?: string
  text?: string
  thinking?: string
  /** `tool_use` fields. */
  id?: string
  name?: string
  input?: Record<string, unknown>
  /** `tool_result` fields. */
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

export type ClaudeMessageEnvelope = {
  type?: string
  subtype?: string
  session_id?: string
  message?: {
    role?: string
    content?: ClaudeContentBlock[] | string
    stop_reason?: string | null
  }
  /** `result` envelope fields. */
  result?: string
  is_error?: boolean
  num_turns?: number
  total_cost_usd?: number
  duration_ms?: number
  /** `stream_event` envelope: a raw Anthropic streaming event. */
  event?: {
    type?: string
    delta?: { type?: string; text?: string; thinking?: string }
    index?: number
  }
  /** `system`/`init` envelope fields. */
  tools?: string[]
  model?: string
  cwd?: string
  /** Present on some envelopes to attribute subagent output. */
  parent_tool_use_id?: string | null
}

/** A user message written to Claude Code's stdin. */
export function buildUserMessage(text: string): Record<string, unknown> {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  }
}

/** Claude Code requires `--session-id` to be a valid UUID. */
export function newClaudeSessionId(): string {
  return randomUUID()
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidClaudeSessionId(id: string): boolean {
  return UUID_PATTERN.test(id)
}

export type ClaudeArgsSpec = {
  /** Fresh session id. Mutually exclusive with `resumeSessionId`. */
  sessionId?: string
  /** Resume an existing conversation instead of starting one. */
  resumeSessionId?: string
  /** With `resumeSessionId`, branch instead of continuing in place. */
  forkSession?: boolean
  model?: string
  /** Path to an MCP config file exposing RAYU's own tools to Claude Code. */
  mcpConfigPath?: string
  /** MCP tool name that answers permission prompts, e.g. `mcp__rayu__approve`. */
  permissionPromptTool?: string
  /** Extra readable/writable roots. */
  addDirs?: readonly string[]
  maxTurns?: number
  maxBudgetUsd?: number
}

/**
 * Build the argv for a headless, stream-driven Claude Code session.
 *
 * ## Security invariants enforced here
 *
 * `--dangerously-skip-permissions` and `--permission-mode bypassPermissions` are
 * never emitted. RAYU must not silently disarm another agent's approval prompts
 * on the user's behalf; if the user wants that, they configure it in Claude
 * Code. Instead `--permission-prompt-tool` routes prompts *back* to RAYU so the
 * user answers them in RAYU's own dialog.
 *
 * `--verbose` is mandatory with `--output-format stream-json`, and
 * `--replay-user-messages` requires stream-json on both sides — both are
 * documented constraints, so they are applied unconditionally rather than left
 * to callers to remember.
 */
export function buildClaudeArgs(spec: ClaudeArgsSpec): string[] {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    // Required by the CLI when output-format is stream-json.
    '--verbose',
    // Echoes our own user messages back so we can confirm delivery rather than
    // assuming a write to stdin was accepted.
    '--replay-user-messages',
  ]

  if (spec.resumeSessionId) {
    args.push('--resume', spec.resumeSessionId)
    if (spec.forkSession) args.push('--fork-session')
  } else if (spec.sessionId) {
    if (!isValidClaudeSessionId(spec.sessionId)) {
      throw new Error(
        `Claude Code requires --session-id to be a UUID; got ${JSON.stringify(spec.sessionId)}.`,
      )
    }
    args.push('--session-id', spec.sessionId)
  }

  if (spec.model) args.push('--model', spec.model)
  if (spec.mcpConfigPath) args.push('--mcp-config', spec.mcpConfigPath)
  if (spec.permissionPromptTool) {
    args.push('--permission-prompt-tool', spec.permissionPromptTool)
  }
  for (const dir of spec.addDirs ?? []) args.push('--add-dir', dir)
  if (spec.maxTurns !== undefined) args.push('--max-turns', String(spec.maxTurns))
  if (spec.maxBudgetUsd !== undefined) {
    args.push('--max-budget-usd', String(spec.maxBudgetUsd))
  }

  return args
}
